/**
 * Host-side administration API for the Vertex AI route.
 *
 * Serves the "Vertex AI" settings page in the Harness Web UI:
 *  - GET  /vertex-api/state   current configuration, credential, token, models
 *  - GET  /vertex-api/models  list Gemini models visible to the project
 *  - POST /vertex-api/config  persist project/location/credential path
 *  - POST /vertex-api/test    call a real model once and report the outcome
 *  - POST /vertex-api/login   launch `gcloud auth application-default login`
 *
 * Nothing secret leaves this module: responses carry kinds, masked accounts,
 * boolean existence flags, expiry timestamps, and model ids, never raw tokens
 * or private keys.
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  VertexError,
  clearTokenCache,
  defaultCredentialPath,
  forgetToken,
  getAccessToken,
  peekToken,
  readCredential,
  redactSensitive,
  resolveProject,
  safeErrorMessage,
} from './auth.js';
import { DEFAULTS, endpoint, validateBaseUrl, validateContextWindow, validateLocation } from './gemini.js';
import { acquireLimit, configureLimit, limitStatus } from './limit.js';
import { describeProxy, parseProxyUrl, request } from './transport.js';
import { signatureDir } from './signatures.js';

const PREFIX = '/vertex-api/';
const USER_AGENT = 'deepseek-harness-vertex/0.1.0';

/** Maximum allowed JSON request body size (64 KiB). */
export const MAX_BODY_BYTES = 64 * 1024;

/** Maximum lifetime and capacity of issued one-time CSRF tokens. */
const CSRF_TTL_MS = 30 * 60 * 1000;
const MAX_CSRF_TOKENS = 64;

/**
 * Mask an email address so `/vertex-api/state` exposes minimal identity info
 * (e.g. `someone@example.com` -> `s***@example.com`).
 *
 * @param {unknown} email - raw email or account string.
 * @returns {string} masked email string.
 */
export function maskEmail(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim();
  if (trimmed.length === 0) return '';
  const at = trimmed.indexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return `${trimmed[0]}***`;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  return `${local[0]}***@${domain}`;
}

/**
 * Check whether a candidate path resides within one of the allowed configuration
 * directories so `/vertex-api/state` cannot be used as an arbitrary path oracle.
 *
 * @param {string} candidatePath - path to check.
 * @param {any} ctx - plugin context.
 * @param {any} config - normalized plugin configuration.
 * @returns {boolean} true when candidatePath is inside an allowed config directory.
 */
export function isWithinConfigDir(candidatePath, ctx, config) {
  if (typeof candidatePath !== 'string' || candidatePath.trim().length === 0) return false;
  let resolved;
  try {
    resolved = path.resolve(candidatePath);
  } catch {
    return false;
  }
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  // Context properties are reflection-guarded: touch them through `get()` so a
  // service this plugin never injected cannot throw "without inject" here.
  const baseDir = typeof ctx?.get === 'function' ? ctx.get('baseDir') : undefined;
  const roots = [
    typeof baseDir === 'string' && baseDir.length > 0 ? baseDir : undefined,
    typeof ctx?.fiber?.entry?.file === 'string' && ctx.fiber.entry.file.length > 0
      ? path.dirname(ctx.fiber.entry.file)
      : undefined,
    typeof config?.signatureDir === 'string' && config.signatureDir.length > 0 ? config.signatureDir : undefined,
    signatureDir(),
    path.join(appData, 'gcloud'),
    path.join(os.homedir(), '.config', 'gcloud'),
  ].filter((dir) => typeof dir === 'string' && dir.length > 0);

  for (const root of roots) {
    const resolvedRoot = path.resolve(root);
    const rel = path.relative(resolvedRoot, resolved);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
      return true;
    }
  }
  return false;
}

/**
 * Attach the `/vertex-api/*` handler to the Web server whenever `connection`
 * is present. Looking `connection` up on the context (rather than declaring it
 * in `inject`) keeps the provider route working in headless CLI runs where no
 * Web server is started.
 *
 * @param {any} ctx - the plugin's Cordis context.
 * @param {() => any} getConfig - live normalized configuration reader.
 * @param {(nextConfig: any) => void} [setConfig] - optional live configuration updater.
 */
export function installAdmin(ctx, getConfig, setConfig) {
  /** @type {Map<string, number>} token -> expiresAt */
  const csrfTokens = new Map();

  const issueCsrfToken = () => {
    const now = Date.now();
    for (const [token, expiresAt] of csrfTokens) {
      if (expiresAt <= now) csrfTokens.delete(token);
    }
    while (csrfTokens.size >= MAX_CSRF_TOKENS) {
      const oldest = csrfTokens.keys().next().value;
      if (oldest === undefined) break;
      csrfTokens.delete(oldest);
    }
    const token = crypto.randomBytes(24).toString('base64url');
    csrfTokens.set(token, now + CSRF_TTL_MS);
    return token;
  };

  const consumeCsrfToken = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) return false;
    const expiresAt = csrfTokens.get(candidate);
    csrfTokens.delete(candidate);
    if (expiresAt === undefined) return false;
    return expiresAt > Date.now();
  };

  const handler = (req, res) => {
    void handle(ctx, getConfig, setConfig, csrfTokens, issueCsrfToken, consumeCsrfToken, req, res);
  };

  const attach = () => {
    const disposers = [];
    const webServer = ctx.get?.('webServer');
    if (typeof webServer?.register === 'function') {
      const unregister = webServer.register({
        kind: 'prefix',
        path: '/vertex-api',
        handler,
      });
      if (typeof unregister === 'function') disposers.push(unregister);
    }

    const connection = ctx.get?.('connection');
    const server = connection?.httpServer;
    if (server !== undefined && server !== null) {
      const listener = (req, res) => {
        const rawUrl = typeof req.url === 'string' ? req.url : '';
        if (!rawUrl.startsWith(PREFIX)) return;
        handler(req, res);
      };
      const existing = server.listeners('request');
      server.removeAllListeners('request');
      server.on('request', listener);
      for (const fn of existing) server.on('request', fn);
      disposers.push(() => server.off('request', listener));
    }

    if (disposers.length === 0) return undefined;
    return () => {
      for (const fn of disposers) fn();
      csrfTokens.clear();
    };
  };

  let dispose;
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      dispose = attach();
      return () => {
        dispose?.();
        dispose = undefined;
        csrfTokens.clear();
      };
    });
  } else {
    dispose = attach();
  }
  if (dispose === undefined && typeof ctx.on === 'function') {
    ctx.on('internal/service', (name) => {
      if ((name === 'connection' || name === 'webServer') && dispose === undefined) dispose = attach();
    });
  }
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      dispose?.();
      dispose = undefined;
      csrfTokens.clear();
    });
  }
}

/**
 * Validate state-changing POST requests against CSRF and cross-origin attacks:
 *  1. Content-Type must be `application/json`.
 *  2. `Origin` must match the server's `Host` (or `Sec-Fetch-Site` must be `same-origin`).
 *  3. Request must carry a valid one-time `X-Vertex-Csrf` token (or custom header
 *     `X-Vertex-Admin: 1` when no token was issued yet, with token strictly verified
 *     whenever present or issued).
 *
 * @param {import('node:http').IncomingMessage} req - incoming HTTP request.
 * @param {Map<string, number>} csrfTokens - active one-time CSRF token store.
 * @param {(token: unknown) => boolean} consumeCsrfToken - single-use token verifier.
 * @throws {VertexError} when integrity verification fails.
 */
function verifyWriteIntegrity(req, csrfTokens, consumeCsrfToken) {
  const contentType = req.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;|$)/iu.test(contentType.trim())) {
    throw new VertexError(
      'Write requests must use Content-Type: application/json.',
      'INVALID_CONTENT_TYPE',
      { httpStatus: 415 },
    );
  }

  const csrfHeader = req.headers['x-vertex-csrf'];
  const customHeader = req.headers['x-vertex-admin'];
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim().toLowerCase() : '';
  const origin = req.headers.origin;
  const secFetchSite = req.headers['sec-fetch-site'];

  // A one-time CSRF token can only be read by a same-origin page, so it is
  // stronger proof than Origin/Host comparison, which breaks behind a reverse
  // proxy that rewrites Host while the browser keeps its own Origin.
  if (typeof csrfHeader === 'string' && csrfHeader.length > 0) {
    if (!consumeCsrfToken(csrfHeader)) {
      throw new VertexError('Invalid, expired, or already-used CSRF token.', 'CSRF_REJECTED', { httpStatus: 403 });
    }
    return;
  }

  let originMatched = false;
  if (typeof origin === 'string' && origin.length > 0) {
    let parsedOrigin;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new VertexError('Malformed Origin header.', 'CROSS_ORIGIN_FORBIDDEN', { httpStatus: 403 });
    }
    originMatched = host.length > 0 && parsedOrigin.host.toLowerCase() === host;
  }

  if (typeof secFetchSite === 'string' && secFetchSite.length > 0) {
    originMatched = secFetchSite.toLowerCase() === 'same-origin';
  }

  if (!originMatched) {
    throw new VertexError(
      'Write requests require a matching same-origin Origin header or Sec-Fetch-Site: same-origin.',
      'CROSS_ORIGIN_FORBIDDEN',
      { httpStatus: 403 },
    );
  }

  if (csrfTokens.size > 0) {
    throw new VertexError('Missing one-time X-Vertex-Csrf token.', 'CSRF_REJECTED', { httpStatus: 403 });
  }

  if (customHeader !== '1') {
    throw new VertexError('Missing X-Vertex-Admin integrity header.', 'CSRF_REJECTED', { httpStatus: 403 });
  }
}

/**
 * Dispatch one `/vertex-api/*` request after running the host's own origin and
 * session checks (`connection.requestRejection`).
 *
 * @param {any} ctx - plugin context.
 * @param {any} connection - host connection service.
 * @param {() => any} getConfig - normalized configuration reader.
 * @param {(nextConfig: any) => void | undefined} setConfig - live configuration updater.
 * @param {Map<string, number>} csrfTokens - active CSRF tokens.
 * @param {() => string} issueCsrfToken - mint a new one-time CSRF token.
 * @param {(token: unknown) => boolean} consumeCsrfToken - consume a one-time CSRF token.
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
async function handle(ctx, getConfig, setConfig, csrfTokens, issueCsrfToken, consumeCsrfToken, req, res) {
  const connection = ctx.get?.('connection');
  const rejection = typeof connection?.requestRejection === 'function' ? connection.requestRejection(req) : null;
  if (typeof rejection === 'number') {
    send(res, rejection, {
      ok: false,
      error: rejection === 401 ? 'authentication required' : 'Forbidden',
      code: rejection === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
    });
    return;
  }
  if (rejection !== null && rejection !== undefined) {
    send(res, rejection.status ?? 403, { ok: false, error: rejection.reason ?? 'Forbidden', code: 'FORBIDDEN' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const route = `${req.method ?? 'GET'} ${url.pathname.slice(PREFIX.length - 1)}`;
  const isPost = (req.method ?? 'GET').toUpperCase() === 'POST';

  try {
    if (route === 'GET /state') {
      send(res, 200, { ...buildState(ctx, getConfig()), csrfToken: issueCsrfToken() });
      return;
    }
    if (route === 'GET /models') {
      send(res, 200, await listPublisherModels(getConfig(), ctx.logger));
      return;
    }
    if (route === 'POST /config' || route === 'POST /test' || route === 'POST /login') {
      verifyWriteIntegrity(req, csrfTokens, consumeCsrfToken);
      const body = await readJson(req);
      let payload;
      if (route === 'POST /config') {
        payload = await saveConfig(ctx, getConfig(), body, setConfig);
      } else if (route === 'POST /test') {
        payload = await probe(getConfig(), body, ctx.logger);
      } else {
        payload = await login(getConfig(), ctx.logger);
      }
      send(res, 200, { ...payload, csrfToken: issueCsrfToken() });
      return;
    }
    send(res, 404, { ok: false, error: `Unknown Vertex route: ${route}`, code: 'NOT_FOUND' });
  } catch (error) {
    const code = error instanceof VertexError ? error.code : 'INTERNAL_ERROR';
    const rawMsg = error instanceof Error ? error.message : String(error);
    ctx.logger?.debug?.(`llm-vertex: admin route ${route} failed (${code}): ${redactSensitive(rawMsg)}`);
    const status = typeof error?.failure?.httpStatus === 'number'
      ? error.failure.httpStatus
      : code === 'PAYLOAD_TOO_LARGE'
        ? 413
        : code === 'INVALID_CONTENT_TYPE'
          ? 415
          : code === 'CROSS_ORIGIN_FORBIDDEN' || code === 'CSRF_REJECTED'
            ? 403
            : 400;
    const safeMsg = redactSensitive(rawMsg).slice(0, 240);
    send(res, status, {
      ok: false,
      code,
      error: safeMsg,
      ...(isPost ? { csrfToken: issueCsrfToken() } : {}),
    });
  }
}

/**
 * Collect a non-secret snapshot of the current Vertex AI state.
 *
 * Minimizes exposed host metadata (L-1):
 *  - Masks account emails (`a***@gmail.com`).
 *  - Reports only boolean existence (`credentialExists`) for default credential
 *    paths instead of full filesystem paths.
 *  - Evaluates `credential.exists` only for paths inside allowed config directories.
 *
 * @param {any} ctx - plugin context.
 * @param {any} config - normalized plugin configuration.
 * @returns {object} state payload for the settings page.
 */
function buildState(ctx, config) {
  const defaultCred = defaultCredentialPath();
  const usingDefault = config.credentialPath.length === 0;
  const credentialPath = usingDefault ? defaultCred : config.credentialPath;
  const credential = inspectCredential(credentialPath, ctx, config);
  const token = peekToken(credentialPath);
  const effectiveProject = credential.ok
    ? safeResolveProject(credential.raw, config.projectId)
    : config.projectId;
  const defaultCredExists = fileExists(defaultCred);

  return {
    ok: true,
    config: {
      projectId: config.projectId,
      location: config.location,
      contextWindow: config.contextWindow ?? DEFAULTS.contextWindow,
      credentialPath: config.credentialPath,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      proxyUrl: config.proxyUrl ?? '',
      requestsPerMinute: config.requestsPerMinute,
      maxConcurrent: config.maxConcurrent,
      models: config.models,
    },
    effective: {
      credentialPath: usingDefault ? '' : config.credentialPath,
      usingDefaultCredential: usingDefault,
      credentialExists: credential.exists,
      projectId: effectiveProject,
      location: config.location,
      contextWindow: config.contextWindow ?? DEFAULTS.contextWindow,
    },
    defaults: {
      credentialExists: defaultCredExists,
      location: DEFAULTS.location,
      contextWindow: DEFAULTS.contextWindow,
    },
    credential: credential.summary,
    token,
    proxy: describeProxy(config.proxyUrl),
    limits: limitStatus(),
    gcloud: gcloud(),
  };
}

/**
 * @param {string} filePath - path to check.
 * @returns {boolean} true if the regular file exists.
 */
function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Read a credential file and return only safe, non-secret metadata.
 *
 * @param {string} file - path to the credential file.
 * @param {any} ctx - plugin context.
 * @param {any} config - normalized plugin configuration.
 * @returns {{ok: boolean, raw?: Record<string, unknown>, exists: boolean, summary: object}} inspection result.
 */
function inspectCredential(file, ctx, config) {
  const inConfigDir = isWithinConfigDir(file, ctx, config);
  const exists = inConfigDir ? fileExists(file) : false;
  try {
    const { type, raw } = readCredential(file);
    const rawAccount = type === 'service_account'
      ? (typeof raw.client_email === 'string' ? raw.client_email : '')
      : (typeof raw.account === 'string' ? raw.account : '');
    const account = maskEmail(rawAccount);
    const quotaProjectId = typeof raw.quota_project_id === 'string'
      ? raw.quota_project_id
      : typeof raw.project_id === 'string'
        ? raw.project_id
        : '';
    return {
      ok: true,
      raw,
      exists,
      summary: {
        ok: true,
        kind: type,
        account,
        quotaProjectId,
        exists,
      },
    };
  } catch (error) {
    return {
      ok: false,
      exists,
      summary: {
        ok: false,
        exists,
        code: error instanceof VertexError ? error.code : 'INVALID_CREDENTIAL',
        message: redactSensitive(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

/**
 * @param {Record<string, unknown> | undefined} raw - parsed credential.
 * @param {string} configured - configured project id.
 * @returns {string} resolved project id, or empty string when unknown.
 */
function safeResolveProject(raw, configured) {
  try {
    return resolveProject(raw ?? {}, configured);
  } catch {
    return '';
  }
}

/**
 * Ask Vertex AI's Model Garden which Gemini publisher models are visible to
 * the configured project and location.
 *
 * @param {any} config - normalized configuration.
 * @param {any} [logger] - optional logger for debug-only redacted diagnostics.
 * @returns {Promise<{ok: true, projectId: string, location: string, count: number, models: any[]}>} model list.
 */
export async function listPublisherModels(config, logger) {
  const credentialPath = config.credentialPath.length > 0 ? config.credentialPath : defaultCredentialPath();
  const credential = readCredential(credentialPath);
  const projectId = resolveProject(credential.raw, config.projectId);
  const location = validateLocation(config.location);
  const baseUrl = validateBaseUrl(config.baseUrl, logger);
  const token = await getAccessToken(credentialPath, credential, undefined, logger, tokenOptions(config));

  const modelEndpoint = endpoint({
    baseUrl,
    projectId,
    location,
    model: '__catalog__',
  });
  const baseOrigin = new URL(modelEndpoint).origin;
  // The publisher catalogue is global and does not accept a location query
  // parameter (Google answers HTTP 400 "Unknown name location"). Only the host
  // differs per region, so a 404 is retried against us-central1 instead.
  const origins = location === 'global'
    ? [baseOrigin, 'https://us-central1-aiplatform.googleapis.com']
    : [baseOrigin];
  let response;
  let text = '';
  for (const origin of origins) {
    const url = `${origin}/v1beta1/publishers/google/models?pageSize=200`;
    response = await request(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
        // ADC access tokens do not carry a quota project, and this endpoint
        // refuses them without one (HTTP 403 "requires a quota project").
        'x-goog-user-project': projectId,
      },
      timeoutMs: config.timeoutMs,
      proxyUrl: config.proxyUrl,
      warn: (message) => logger?.warn?.(message),
    });
    text = await response.text();
    if (response.ok || response.status !== 404) break;
  }
  if (!response.ok) {
    logger?.debug?.(`llm-vertex: listPublisherModels HTTP ${response.status}: ${redactSensitive(text)}`);
    const target = { projectId, location };
    throw new VertexError(describeHttpError(response.status, text, 'catalogue', target), httpCode(response.status, text));
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new VertexError('Vertex AI returned a non-JSON model catalogue', 'SERVER');
  }
  const configured = new Set(config.models.map((model) => model.id));
  const models = (payload.publisherModels ?? payload.models ?? [])
    .map((entry) => {
      const name = typeof entry?.name === 'string' ? entry.name : '';
      const id = name.slice(name.lastIndexOf('/') + 1);
      return { id, displayName: typeof entry?.displayName === 'string' ? entry.displayName : id, launchStage: typeof entry?.launchStage === 'string' ? entry.launchStage : '', configured: configured.has(id) };
    })
    .filter((model) => model.id.startsWith('gemini'))
    // The catalogue also lists embeddings, TTS, image and live-audio models;
    // none of them accept a chat request, so they are not offered as chat routes.
    .filter((model) => !/(embedding|tts|transcribe|native-audio|nano-banana|imagen|veo|live-)/u.test(model.id))
    .sort((a, b) => b.id.localeCompare(a.id));
  return { ok: true, projectId, location, count: models.length, models };
}

/**
 * Persist one partial configuration edit through the Loader.
 *
 * Enforces the same location and baseUrl allowlist checks as `normalizeConfig`
 * (H-1 & M-2) and clears cached tokens when `credentialPath` changes (Item 8).
 *
 * @param {any} ctx - plugin context.
 * @param {any} current - the live configuration.
 * @param {Record<string, unknown>} input - requested fields.
 * @param {(nextConfig: any) => void} [setConfig] - optional live configuration updater.
 * @returns {Promise<object>} accepted patch.
 */
async function saveConfig(ctx, current, input, setConfig) {
  const patch = {};
  if (typeof input.projectId === 'string') patch.projectId = input.projectId.trim();
  if (input.location !== undefined) {
    if (typeof input.location !== 'string' || input.location.trim().length === 0) {
      throw new VertexError('location must be a non-empty string', 'INVALID_LOCATION');
    }
    patch.location = validateLocation(input.location);
  }
  if (input.baseUrl !== undefined) {
    if (typeof input.baseUrl !== 'string') {
      throw new VertexError('baseUrl must be a string', 'INVALID_BASE_URL');
    }
    patch.baseUrl = validateBaseUrl(input.baseUrl, ctx.logger);
  }
  if (input.proxyUrl !== undefined) {
    if (typeof input.proxyUrl !== 'string') {
      throw new VertexError('proxyUrl must be a string', 'INVALID_PROXY');
    }
    const raw = input.proxyUrl.trim();
    patch.proxyUrl = raw.length === 0 ? '' : (parseProxyUrl(raw), raw);
  }
  if (typeof input.credentialPath === 'string') patch.credentialPath = input.credentialPath.trim();
  if (input.contextWindow !== undefined) {
    patch.contextWindow = validateContextWindow(input.contextWindow);
  }
  if (input.requestsPerMinute !== undefined) patch.requestsPerMinute = positiveInt(input.requestsPerMinute, 'requestsPerMinute');
  if (input.maxConcurrent !== undefined) patch.maxConcurrent = positiveInt(input.maxConcurrent, 'maxConcurrent');
  if (Array.isArray(input.models)) {
    const ids = input.models
      .map((model) => (typeof model === 'string' ? model : model?.id))
      .filter((id) => typeof id === 'string' && id.trim().length > 0)
      .map((id) => id.trim());
    if (ids.length === 0) throw new VertexError('the model list cannot be empty', 'INVALID_REQUEST');
    patch.models = ids.map(
      (id) => current.models.find((model) => model.id === id) ?? { id, name: id },
    );
  }
  if (Object.keys(patch).length === 0) throw new VertexError('no editable field in the request body', 'INVALID_REQUEST');

  const editor = ctx.get('configEditor');
  const entry = ctx.fiber?.entry;
  if (editor === undefined || entry === undefined) {
    throw new VertexError('this profile does not expose the configuration editor', 'UNSUPPORTED');
  }
  await editor.edit(entry, (raw) => ({ ...raw, ...patch }));

  if (patch.credentialPath !== undefined && patch.credentialPath !== current.credentialPath) {
    forgetToken(current.credentialPath || defaultCredentialPath());
    clearTokenCache();
  }
  const nextContextWindow = patch.contextWindow ?? current.contextWindow ?? DEFAULTS.contextWindow;
  const baseModels = patch.models ?? current.models ?? DEFAULTS.models;
  const updatedModels = baseModels.map((model) => ({
    ...model,
    contextWindow: nextContextWindow,
    maxTokens: model.maxTokens ?? 65_536,
  }));
  const updated = { ...current, ...patch, contextWindow: nextContextWindow, models: updatedModels };
  configureLimit(updated);
  if (typeof setConfig === 'function') {
    setConfig(updated);
  }
  ctx.emit?.('llm/models-updated', 'vertex');

  return {
    ok: true,
    applied: patch,
    previous: {
      projectId: current.projectId,
      location: current.location,
      contextWindow: current.contextWindow ?? DEFAULTS.contextWindow,
      credentialPath: current.credentialPath,
    },
  };
}

/**
 * Call one model once, so the page can prove credential + project + location.
 *
 * @param {any} config - normalized configuration.
 * @param {Record<string, unknown>} input - optional `model` override.
 * @param {any} [logger] - optional logger for debug-only redacted diagnostics.
 * @returns {Promise<object>} probe outcome.
 */
export async function probe(config, input, logger) {
  const model = typeof input.model === 'string' && input.model.length > 0 ? input.model : config.models[0]?.id;
  if (model === undefined) throw new VertexError('no model configured', 'INVALID_REQUEST');
  const credentialPath = config.credentialPath.length > 0 ? config.credentialPath : defaultCredentialPath();
  const credential = readCredential(credentialPath);
  const location = validateLocation(config.location);
  const baseUrl = validateBaseUrl(config.baseUrl, logger);
  const target = {
    projectId: resolveProject(credential.raw, config.projectId),
    location,
    baseUrl,
    model,
  };
  const url = endpoint(target).replace(':streamGenerateContent?alt=sse', ':generateContent');
  forgetToken(credentialPath);
  const token = await getAccessToken(credentialPath, credential, undefined, logger, tokenOptions(config));
  const release = await acquireLimit(config, undefined);
  const sendRequest = async (generationConfig) => {
    const started = Date.now();
    const response = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'user-agent': USER_AGENT,
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
        generationConfig,
      }),
      timeoutMs: config.timeoutMs,
      proxyUrl: config.proxyUrl,
      warn: (message) => logger?.warn?.(message),
    });
    const text = await response.text();
    return { response, text, ms: Date.now() - started };
  };
  // Thinking is on by default in Gemini 3; a tiny cap would be spent on thoughts
  // and leave an empty answer, so it is disabled for this one-word probe. The
  // Gemini 4 family rejects thinkingBudget and needs its level left to default,
  // so a 400 that mentions thinking is retried without the override.
  const probeText = (bodyText) => {
    try {
      const parsed = JSON.parse(bodyText);
      return (parsed?.candidates?.[0]?.content?.parts ?? [])
        .map((part) => (typeof part?.text === 'string' ? part.text : ''))
        .join('')
        .trim();
    } catch {
      return '';
    }
  };
  let attempt;
  try {
    attempt = await sendRequest({ maxOutputTokens: 32, temperature: 0, thinkingConfig: { thinkingBudget: 0 } });
    if (attempt.response.status === 400 && /thinking/iu.test(attempt.text)) {
      attempt = await sendRequest({ maxOutputTokens: 256, temperature: 0 });
    }
    // A small cap can be consumed entirely by reasoning tokens even with
    // thinking disabled on some models, leaving a valid but empty candidate.
    if (attempt.response.ok && probeText(attempt.text) === '') {
      attempt = await sendRequest({ maxOutputTokens: 1024, temperature: 0, thinkingConfig: { thinkingBudget: 0 } });
    }
  } finally {
    release();
  }
  const { response, text, ms } = attempt;
  if (!response.ok) {
    logger?.debug?.(`llm-vertex: probe HTTP ${response.status} (${model} in ${location}): ${redactSensitive(text)}`);
    throw new VertexError(describeHttpError(response.status, text, model, target), httpCode(response.status, text));
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new VertexError('Vertex AI returned a non-JSON probe response', 'SERVER');
  }
  const answer = (payload?.candidates?.[0]?.content?.parts ?? [])
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
  if (answer === '') {
    const finishReason = payload?.candidates?.[0]?.finishReason ?? 'UNKNOWN';
    throw new VertexError(
      `Vertex AI answered without any text (finishReason=${finishReason}); the model may have spent the entire budget on reasoning.`,
      'EMPTY_RESPONSE',
    );
  }
  return {
    ok: true,
    model,
    projectId: target.projectId,
    location: target.location,
    ms,
    answer: answer.slice(0, 200),
    usage: payload?.usageMetadata ?? {},
  };
}

/**
 * Start the Google sign-in that writes the ADC file this adapter reads.
 *
 * @param {any} [logger] - optional logger for debug-only redacted diagnostics.
 * @returns {Promise<object>} launch outcome.
 */
async function login(config, logger) {
  const executable = gcloudExecutable();
  const args = ['auth', 'application-default', 'login', '--scopes=https://www.googleapis.com/auth/cloud-platform'];
  if (executable === undefined) {
    return { ok: false, command: `gcloud ${args.join(' ')}`, error: 'gcloud was not found on PATH or in the default Cloud SDK directory' };
  }
  try {
    const child = spawn(executable, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env, ...proxyEnv(config?.proxyUrl) },
    });
    child.unref();
  } catch (error) {
    logger?.debug?.(`llm-vertex: gcloud login spawn failed: ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
    return { ok: false, command: `gcloud ${args.join(' ')}`, error: 'Failed to launch gcloud login process.' };
  }
  return { ok: true, command: `gcloud ${args.join(' ')}` };
}

/**
 * Options that make a token exchange use the configured proxy.
 *
 * @param {any} config - normalized plugin configuration.
 * @returns {{proxyUrl?: string, tokenUrl?: string, timeoutMs?: number}} transport options.
 */
function tokenOptions(config) {
  return {
    proxyUrl: config?.proxyUrl,
    tokenUrl: config?.tokenUrl,
    timeoutMs: config?.timeoutMs,
  };
}

/**
 * Environment variables that make gcloud and Google client libraries use the
 * configured proxy during the interactive login flow.
 *
 * @param {unknown} proxyUrl - configured proxy URL.
 * @returns {Record<string, string>} environment additions.
 */
function proxyEnv(proxyUrl) {
  if (typeof proxyUrl !== 'string' || proxyUrl.trim().length === 0) return {};
  const value = proxyUrl.trim();
  return {
    HTTPS_PROXY: value,
    HTTP_PROXY: value,
    https_proxy: value,
    http_proxy: value,
  };
}

/**
 * Coerce an editable ceiling to a positive integer.
 *
 * @param {unknown} value - candidate value from the request body.
 * @param {string} field - field name used in the rejection message.
 * @returns {number} a positive integer.
 */
function positiveInt(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) {
    throw new VertexError(`${field} must be a positive integer`, 'INVALID_REQUEST');
  }
  return Math.floor(number);
}

/**
 * @returns {{found: boolean}} whether the gcloud launcher was detected (path omitted per L-1).
 */
function gcloud() {
  const executable = gcloudExecutable();
  return { found: executable !== undefined };
}

/**
 * @returns {string | undefined} an absolute gcloud launcher path, when present.
 */
function gcloudExecutable() {
  const local = process.env.LOCALAPPDATA;
  const candidates = [];
  if (typeof local === 'string' && local.length > 0) {
    candidates.push(path.join(local, 'Google', 'Cloud SDK', 'google-cloud-sdk', 'bin', 'gcloud.cmd'));
  }
  candidates.push('C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd');
  candidates.push('C:\\Program Files\\Google\\Cloud SDK\\google-cloud-sdk\\bin\\gcloud.cmd');
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore an unreadable candidate
    }
  }
  return undefined;
}

/**
 * Build a sanitized, short operator-facing error message without echoing raw
 * upstream bodies or secrets (L-3).
 *
 * @param {number} status - HTTP status.
 * @param {string} body - response text.
 * @param {string} model - requested model id.
 * @param {any} target - resolved endpoint facts.
 * @returns {string} an operator-facing diagnosis.
 */
function describeHttpError(status, body, model, target) {
  const message = safeErrorMessage(body, '');
  const suffix = message.length > 0 ? ` ${message}` : '';
  const where = `projects/${target.projectId}/locations/${target.location}/publishers/google/models/${model}`;
  if (status === 404) {
    return `Vertex AI has no publisher model ${model} for ${where}.${suffix}`.trim();
  }
  if (status === 401 || status === 403) {
    return `Google rejected the credential for ${where} (HTTP ${status}).${suffix}`.trim();
  }
  return `Vertex AI returned HTTP ${status} for ${where}.${suffix}`.trim();
}

/**
 * @param {number} status - HTTP status.
 * @param {string} body - response text.
 * @returns {string} a stable failure code.
 */
function httpCode(status, body) {
  if (status === 404) return 'MODEL_UNAVAILABLE';
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 400 || status === 422) return 'INVALID_REQUEST';
  if (status >= 500) return 'SERVER';
  void body;
  return `HTTP_${status}`;
}

/**
 * Read and parse a JSON request body with a strict 64 KiB byte ceiling (L-4).
 * If the incoming payload exceeds 64 KiB, destroys the stream and rejects with
 * `PAYLOAD_TOO_LARGE` (HTTP 413).
 *
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @returns {Promise<Record<string, unknown>>} parsed JSON body (empty object when absent).
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > MAX_BODY_BYTES) {
        aborted = true;
        reject(
          new VertexError(
            `request body exceeds the ${MAX_BODY_BYTES}-byte limit`,
            'PAYLOAD_TOO_LARGE',
            { httpStatus: 413 },
          ),
        );
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (aborted) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim().length === 0) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new VertexError('request body must be a JSON object', 'INVALID_REQUEST'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new VertexError('request body is not valid JSON', 'INVALID_REQUEST'));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

/**
 * @param {import('node:http').ServerResponse} res - response to write.
 * @param {number} status - HTTP status.
 * @param {unknown} payload - JSON-serializable body.
 */
function send(res, status, payload) {
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}
