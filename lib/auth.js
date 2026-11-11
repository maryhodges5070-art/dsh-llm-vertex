/**
 * Google Cloud credential handling for the Vertex AI adapter.
 *
 * Supported credential files:
 *  - authorized_user  (gcloud application-default login; refresh_token grant)
 *  - service_account  (RS256-signed JWT exchanged at the OAuth token endpoint)
 *
 * Tokens are cached in memory only; nothing secret is written to disk or logged.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VertexError } from './errors.js';
import { request } from './transport.js';

export { VertexError };

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Effective token endpoint: env override (tests / private mirrors) or Google. */
function defaultTokenUrl() {
  const override = process.env.DSH_VERTEX_TOKEN_URL;
  return typeof override === 'string' && override.length > 0 ? override : TOKEN_URL;
}
const SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Maximum allowed size for a credential JSON file (256 KiB) to prevent OOM on stray files. */
export const MAX_CREDENTIAL_BYTES = 256 * 1024;

/** path -> { token, expiresAt } */
const tokenCache = new Map();

/**
 * Redact bearer tokens, refresh tokens, PEM private keys, and local filesystem
 * paths from diagnostic or log strings.
 *
 * @param {unknown} input - raw error or response text.
 * @returns {string} redacted text safe for logs.
 */
export function redactSensitive(input) {
  const text = typeof input === 'string' ? input : String(input ?? '');
  return text
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gu, '[REDACTED_PRIVATE_KEY]')
    .replace(/"private_key"\s*:\s*"[^"]*"/gu, '"private_key":"[REDACTED_PRIVATE_KEY]"')
    .replace(/\bya29\.[A-Za-z0-9._-]+/gu, 'ya29.[REDACTED]')
    .replace(/\b1\/\/[A-Za-z0-9._-]+/gu, '1//[REDACTED]')
    .replace(/(?:[A-Za-z]:\\|\/(?:Users|home|root|var|tmp|etc|opt|private|mnt)\/)[^\s"'`,;()[\]{}]+/gu, '[REDACTED_PATH]');
}

/**
 * Extract a short, sanitized error message suitable for external responses.
 *
 * @param {unknown} rawBody - upstream response text or error message.
 * @param {string} fallback - fallback short summary when none can be parsed.
 * @returns {string} sanitized short message (max 200 chars).
 */
export function safeErrorMessage(rawBody, fallback) {
  let candidate = '';
  if (typeof rawBody === 'string' && rawBody.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawBody);
      const msg = parsed?.error?.message ?? parsed?.error_description ?? parsed?.error;
      if (typeof msg === 'string' && msg.trim().length > 0) {
        candidate = msg.trim();
      }
    } catch {
      // Ignore JSON parse failures; do not echo raw unparsed body to external callers.
    }
  }
  const clean = redactSensitive(candidate || fallback).replace(/\s+/gu, ' ').trim();
  return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

/**
 * The credential file the adapter reads when configuration names none.
 *
 * @returns {string} an absolute path, whether or not it exists.
 */
export function defaultCredentialPath() {
  const fromEnv = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim();
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'gcloud', 'application_default_credentials.json');
}

/**
 * Read a file with a strict byte ceiling before reading its contents into memory.
 *
 * @param {string} file - path to the credential file.
 * @param {number} maxBytes - maximum allowed file size in bytes.
 * @returns {string} UTF-8 file contents.
 */
function readBoundedFile(file, maxBytes = MAX_CREDENTIAL_BYTES) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new VertexError('Vertex AI credential path is not a regular file.', 'INVALID_CREDENTIAL');
    }
    if (stat.size > maxBytes) {
      throw new VertexError(
        `Vertex AI credential file exceeds the ${maxBytes}-byte safety ceiling.`,
        'INVALID_CREDENTIAL',
      );
    }
    const buf = Buffer.allocUnsafe(stat.size);
    const bytesRead = fs.readSync(fd, buf, 0, stat.size, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if (error instanceof VertexError) throw error;
    throw new VertexError(
      'Vertex AI credential file is unreadable. ' +
        'Sign in with "gcloud auth application-default login" or point credentialPath at a service-account JSON key.',
      'MISSING_CREDENTIAL',
    );
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors.
      }
    }
  }
}

/**
 * Read and minimally validate a credential JSON document.
 *
 * @param {string} file - absolute path of the credential file.
 * @returns {{type: string, raw: Record<string, unknown>}} the credential kind and document.
 * @throws {VertexError} when the file is unreadable, oversized, or of an unsupported kind.
 */
export function readCredential(file) {
  const text = readBoundedFile(file, MAX_CREDENTIAL_BYTES);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new VertexError('Vertex AI credential file is not valid JSON.', 'INVALID_CREDENTIAL');
  }
  const type = raw?.type;
  if (type !== 'authorized_user' && type !== 'service_account') {
    throw new VertexError(
      `Vertex AI does not support credential type "${String(type)}". ` +
        'Use an authorized_user ADC file (gcloud auth application-default login) or a service_account JSON key.',
      'INVALID_CREDENTIAL',
    );
  }
  return { type, raw };
}

/**
 * Resolve the Google Cloud project that bills Vertex calls.
 *
 * @param {Record<string, unknown>} credential - the parsed credential document.
 * @param {string | undefined} configured - project id from plugin configuration.
 * @returns {string} a non-empty project id or number.
 * @throws {VertexError} when no project can be determined.
 */
export function resolveProject(credential, configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  const quota = credential?.quota_project_id;
  if (typeof quota === 'string' && quota.trim().length > 0) return quota.trim();
  const fromGcloud = gcloudConfiguredProject();
  if (fromGcloud !== undefined) return fromGcloud;
  throw new VertexError(
    'Vertex AI needs a Google Cloud project: set projectId in the plugin configuration, ' +
      'or run "gcloud config set project <id>", or use a credential file that carries quota_project_id.',
    'MISSING_PROJECT',
  );
}

/**
 * Read the default project from the local gcloud configuration if one exists.
 *
 * @returns {string | undefined} the project id, or undefined when none is set.
 */
function gcloudConfiguredProject() {
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const activePath = path.join(appData, 'gcloud', 'active_config');
  let active = 'default';
  try {
    const name = readBoundedFile(activePath, 4096).trim();
    if (name.length > 0 && /^[A-Za-z0-9_-]+$/u.test(name)) active = name;
  } catch {
    // Default configuration name applies when active_config is absent.
  }
  const configPath = path.join(appData, 'gcloud', 'configurations', `config_${active}`);
  try {
    const ini = readBoundedFile(configPath, 64 * 1024);
    const match = /^\s*project\s*=\s*(\S+)\s*$/mu.exec(ini);
    return match?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Obtain a valid OAuth2 access token for the credential file, refreshing it
 * when the cached token is missing or within five minutes of expiry.
 *
 * @param {string} credentialFile - path to the credential JSON file.
 * @param {{type: string, raw: Record<string, unknown>}} credential - parsed credential.
 * @param {AbortSignal | undefined} signal - caller cancellation signal.
 * @param {any} [logger] - optional logger for debug-only redacted diagnostics.
 * @returns {Promise<string>} a bearer access token.
 */
export async function getAccessToken(credentialFile, credential, signal, logger, options = {}) {
  const cacheKey = path.resolve(credentialFile);
  const cached = tokenCache.get(cacheKey);
  const now = Date.now();
  if (cached !== undefined && cached.expiresAt - now > TOKEN_REFRESH_SKEW_MS) {
    return cached.token;
  }
  const fresh = credential.type === 'service_account'
    ? await exchangeServiceAccount(credential.raw, signal, logger, options)
    : await exchangeAuthorizedUser(credential.raw, signal, logger, options);
  tokenCache.set(cacheKey, fresh);
  return fresh.token;
}

/**
 * Drop the cached access token for a credential file so the next call refreshes,
 * or clear all cached tokens when no path is given.
 *
 * @param {string} [credentialFile] - path to the credential JSON file.
 * @returns {void}
 */
export function forgetToken(credentialFile) {
  if (typeof credentialFile === 'string' && credentialFile.trim().length > 0) {
    tokenCache.delete(path.resolve(credentialFile));
    tokenCache.delete(credentialFile);
    return;
  }
  tokenCache.clear();
}

/**
 * Clear every cached access token (used on plugin dispose or credential switch).
 *
 * @returns {void}
 */
export function clearTokenCache() {
  tokenCache.clear();
}

/**
 * Inspect the in-memory token cache for a credential file without refreshing.
 *
 * @param {string} credentialFile - path to the credential JSON file.
 * @returns {{cached: boolean, expiresAt?: number, expiresInMs?: number}} cache state.
 */
export function peekToken(credentialFile) {
  const entry = tokenCache.get(path.resolve(credentialFile)) ?? tokenCache.get(credentialFile);
  if (entry === undefined) return { cached: false };
  return {
    cached: true,
    expiresAt: entry.expiresAt,
    expiresInMs: Math.max(0, entry.expiresAt - Date.now()),
  };
}

/**
 * Exchange an `authorized_user` refresh token for a short-lived access token.
 *
 * @param {Record<string, unknown>} raw - the authorized_user JSON fields.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @param {any} [logger] - optional debug logger.
 * @returns {Promise<{token: string, expiresAt: number}>} the token and its expiry epoch ms.
 */
async function exchangeAuthorizedUser(raw, signal, logger, options = {}) {
  const clientId = stringField(raw, 'client_id');
  const clientSecret = stringField(raw, 'client_secret');
  const refreshToken = stringField(raw, 'refresh_token');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
  });
  return requestToken(body, signal, 'authorized_user refresh_token', logger, undefined, options);
}

/**
 * Exchange a `service_account` private key for a short-lived access token via
 * the OAuth 2.0 JWT bearer grant.
 *
 * @param {Record<string, unknown>} raw - the service_account JSON fields.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @param {any} [logger] - optional debug logger.
 * @returns {Promise<{token: string, expiresAt: number}>} the token and its expiry epoch ms.
 */
async function exchangeServiceAccount(raw, signal, logger, options = {}) {
  const clientEmail = stringField(raw, 'client_email');
  const privateKey = stringField(raw, 'private_key');
  const tokenUri = typeof raw.token_uri === 'string' && raw.token_uri.length > 0
    ? raw.token_uri
    : (options.tokenUrl || defaultTokenUrl());
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const claim = base64UrlJson({
    iss: clientEmail,
    scope: SCOPE,
    aud: tokenUri,
    iat,
    exp,
  });
  const unsigned = `${header}.${claim}`;
  let signature;
  try {
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(unsigned);
    signer.end();
    signature = signer.sign(privateKey).toString('base64url');
  } catch (error) {
    logger?.debug?.(`llm-vertex: service_account key signing failed: ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
    throw new VertexError(
      'Vertex AI service_account private_key could not sign a JWT.',
      'INVALID_CREDENTIAL',
    );
  }
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: `${unsigned}.${signature}`,
  });
  return requestToken(body, signal, 'service_account jwt-bearer', logger, tokenUri, options);
}

/**
 * POST a token grant to Google's OAuth2 token endpoint.
 *
 * @param {URLSearchParams} body - form-encoded grant request.
 * @param {AbortSignal | undefined} signal - cancellation signal.
 * @param {string} grantLabel - human label for error messages.
 * @param {any} [logger] - optional debug logger.
 * @param {string} [url] - token endpoint override from service_account JSON.
 * @returns {Promise<{token: string, expiresAt: number}>} the token and expiry.
 */
async function requestToken(body, signal, grantLabel, logger, url, options = {}) {
  const endpoint = url ?? (options.tokenUrl || defaultTokenUrl());
  let response;
  try {
    response = await request(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal,
      timeoutMs: options.timeoutMs ?? 60_000,
      proxyUrl: options.proxyUrl,
      warn: (message) => logger?.warn?.(message),
    });
  } catch (error) {
    logger?.debug?.(`llm-vertex: OAuth2 network error (${grantLabel}): ${redactSensitive(error instanceof Error ? error.message : String(error))}`);
    if (error instanceof VertexError) {
      throw new VertexError(
        `Vertex AI OAuth2 token exchange failed (${grantLabel}): ${error.message}`,
        'AUTH_NETWORK_ERROR',
      );
    }
    throw new VertexError(
      `Vertex AI OAuth2 token exchange failed (${grantLabel}): could not reach endpoint.`,
      'AUTH_NETWORK_ERROR',
    );
  }
  const text = await response.text();
  if (!response.ok) {
    logger?.debug?.(`llm-vertex: OAuth2 token endpoint HTTP ${response.status} (${grantLabel}): ${redactSensitive(text)}`);
    const summary = safeErrorMessage(text, `HTTP ${response.status}`);
    throw new VertexError(
      `Vertex AI OAuth2 token exchange was rejected (${grantLabel}, HTTP ${response.status}): ${summary}. ` +
        'If your ADC session expired, run "gcloud auth application-default login".',
      'AUTH_REJECTED',
    );
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new VertexError(`Vertex AI OAuth2 endpoint returned non-JSON (${grantLabel}).`, 'AUTH_INVALID_RESPONSE');
  }
  const token = payload?.access_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new VertexError(`Vertex AI OAuth2 response contained no access_token (${grantLabel}).`, 'AUTH_INVALID_RESPONSE');
  }
  const expiresInSec = typeof payload.expires_in === 'number' && Number.isFinite(payload.expires_in) ? payload.expires_in : 3600;
  return { token, expiresAt: Date.now() + expiresInSec * 1000 };
}

/**
 * Read a required non-empty string field from a credential object.
 *
 * @param {Record<string, unknown>} raw - parsed JSON object.
 * @param {string} key - required field name.
 * @returns {string} the string value.
 */
function stringField(raw, key) {
  const value = raw?.[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new VertexError(`Vertex AI credential file is missing required field "${key}".`, 'INVALID_CREDENTIAL');
  }
  return value;
}

/**
 * @param {Record<string, unknown>} value - JSON-serializable header or claim set.
 * @returns {string} base64url-encoded JSON.
 */
function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
