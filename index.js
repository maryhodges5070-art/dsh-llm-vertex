/**
 * Google Cloud Vertex AI (Gemini) provider route for DeepSeek Harness.
 *
 * Registers the `vertex` provider route with the host `llm` service and streams
 * Gemini `streamGenerateContent` responses as Harness chunks. Authentication
 * comes from a Google Cloud credential JSON file (gcloud ADC or a service
 * account key): a static API key cannot call Vertex AI.
 */
import { VertexError, clearTokenCache, defaultCredentialPath, readCredential, resolveProject } from './lib/auth.js';
import { DEFAULTS, projectConversation, streamVertex, validateBaseUrl, validateContextWindow, validateLocation } from './lib/gemini.js';
import { installAdmin } from './lib/admin.js';
import { parseProxyUrl } from './lib/transport.js';

/** Provider route registered by this plugin. */
const PROVIDER = 'vertex';

/** Gemini routes accept text and images unless a model opts out. */
const DEFAULT_MODALITIES = Object.freeze(['text', 'image']);

/**
 * Normalize a per-model `input` modality list.
 *
 * @param {unknown} raw - configured `input` value.
 * @returns {string[]} a de-duplicated subset of `text` / `image`.
 */
function normalizeModalities(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_MODALITIES];
  const picked = raw.filter((entry) => entry === 'text' || entry === 'image');
  return picked.length > 0 ? [...new Set(picked)] : [...DEFAULT_MODALITIES];
}

/** Plugin name shown by the Loader and Plugin Manager. */
export const name = 'llm-vertex';

/** Host services required before this plugin can mount. */
export const inject = ['llm'];

/**
 * Normalize and validate the Loader row configuration.
 *
 * Rejects invalid `location` (must match `/^[a-z0-9-]{1,40}$/` and belong to
 * the known Vertex AI region allowlist) and invalid `baseUrl` (must be `https:`
 * on `*.googleapis.com`, or a local `127.0.0.1` / `localhost` proxy with an
 * explicit warning).
 *
 * @param {unknown} raw - the row's `config` value.
 * @param {{warn?: (msg: string) => void}} [logger] - optional logger for warnings.
 * @returns {any} configuration with documented defaults applied.
 */
export function normalizeConfig(raw, logger) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const rawLocation = typeof input.location === 'string' && input.location.trim().length > 0
    ? input.location.trim()
    : DEFAULTS.location;
  const location = validateLocation(rawLocation);
  const baseUrl = validateBaseUrl(input.baseUrl, logger);
  const proxyUrl = proxySetting(input.proxyUrl);
  const contextWindow = validateContextWindow(input.contextWindow);

  const models = Array.isArray(input.models) && input.models.length > 0
    ? input.models
        .filter((model) => model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id.length > 0)
        .map((model) => ({
          id: String(model.id),
          name: typeof model.name === 'string' && model.name.length > 0 ? model.name : String(model.id),
          contextWindow: Math.min(positiveInt(model.contextWindow, 1_048_576), contextWindow),
          maxTokens: positiveInt(model.maxTokens, 65_536),
          input: normalizeModalities(model.input),
          ...(typeof model.description === 'string' && model.description.length > 0
            ? { description: model.description }
            : {}),
        }))
    : DEFAULTS.models.map((model) => ({
        ...model,
        input: model.input ?? DEFAULT_MODALITIES,
        contextWindow: Math.min(model.contextWindow, contextWindow),
      }));
  return {
    credentialPath: typeof input.credentialPath === 'string' ? input.credentialPath.trim() : '',
    projectId: typeof input.projectId === 'string' ? input.projectId.trim() : '',
    location,
    contextWindow,
    timeoutMs: positiveInt(input.timeoutMs, DEFAULTS.timeoutMs),
    // Budget for the response headers; cold models can take minutes. The idle
    // budget above only starts once the stream is open.
    firstByteTimeoutMs: positiveInt(input.firstByteTimeoutMs, DEFAULTS.firstByteTimeoutMs),
    firstTokenTimeoutMs: positiveInt(input.firstTokenTimeoutMs, DEFAULTS.firstTokenTimeoutMs),
    // How long a first attempt may stay completely silent before it is retried.
    silenceRetryMs: positiveInt(input.silenceRetryMs, DEFAULTS.silenceRetryMs),
    baseUrl,
    proxyUrl,
    tokenUrl: process.env.DSH_VERTEX_TOKEN_URL ?? '',
    signatureDir: typeof input.signatureDir === 'string' ? input.signatureDir.trim() : '',
    requestsPerMinute: positiveInt(input.requestsPerMinute, DEFAULTS.requestsPerMinute),
    maxConcurrent: positiveInt(input.maxConcurrent, DEFAULTS.maxConcurrent),
    acquireTimeoutMs: positiveInt(input.acquireTimeoutMs, DEFAULTS.acquireTimeoutMs),
    maxToolResultChars: nonNegativeInt(input.maxToolResultChars, DEFAULTS.maxToolResultChars),
    redactToolResults: input.redactToolResults === true,
    models,
  };
}

/**
 * Validate an optional proxy URL and return a normalized copy.
 *
 * @param {unknown} value - candidate proxy URL from the Loader row.
 * @returns {string} trimmed proxy URL, or '' for a direct connection.
 */
function proxySetting(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new VertexError('proxyUrl must be a string', 'INVALID_PROXY');
  const trimmed = value.trim();
  if (trimmed.length === 0) return '';
  parseProxyUrl(trimmed);
  return trimmed;
}

/**
 * @param {unknown} value - candidate number.
 * @param {number} fallback - value used when the candidate is not a positive integer.
 * @returns {number} a positive integer.
 */
function positiveInt(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * @param {unknown} value - candidate number.
 * @param {number} fallback - value used when the candidate is not a non-negative integer.
 * @returns {number} a non-negative integer.
 */
function nonNegativeInt(value, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * The Vertex AI provider adapter.
 *
 * Implements only the parts of the host LlmAdapter contract this route needs:
 * metadata, catalog, exact-model resolution, and the streaming call.
 */
export class VertexAdapter {
  /**
   * @param {any} config - normalized plugin configuration.
   * @param {any} [logger] - optional host logger for diagnostics.
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
  }

  /**
   * Describe the route this adapter owns.
   *
   * @param {string} provider - the registered route id.
   * @returns {{id: string, name: string}} detached display metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: 'Google Vertex AI' };
  }

  /**
   * Vertex AI bills retries against the same quota, so the host default applies.
   *
   * @returns {undefined} no provider-specific retry policy.
   */
  providerRetryPolicy() {
    return undefined;
  }

  /**
   * Gemini image endpoints are not part of this route.
   *
   * @returns {undefined} no image pricing descriptor.
   */
  imageRequestPricing() {
    return undefined;
  }

  /**
   * Gemini accepts inline image parts up to its request budget.
   *
   * @param {string} _provider - route id.
   * @param {string} _model - model id.
   * @param {any} image - the attachment reference being sent.
   * @returns {{width: number, height: number, maxBytes: number}} request target.
   */
  imageRequestTarget(_provider, _model, image) {
    const width = positiveInt(image?.width, 1_024);
    const height = positiveInt(image?.height, 1_024);
    const scale = Math.min(1, 2_048 / Math.max(width, height));
    return {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      maxBytes: 4_000_000,
    };
  }

  /**
   * Advertise the Gemini models available to the model picker.
   *
   * @returns {Promise<any[]>} catalog entries.
   */
  listModels() {
    return Promise.resolve(
      this.config.models.map((model) => ({
        provider: PROVIDER,
        id: model.id,
        name: model.name,
        ...(model.description === undefined ? {} : { description: model.description }),
        inputModalities: model.input,
      })),
    );
  }

  /**
   * Resolve the capability metadata of one exact model.
   *
   * @param {string} provider - the registered route id.
   * @param {string} model - requested model id.
   * @returns {Promise<any>} resolved model metadata.
   */
  resolveModel(provider, model) {
    const known = this.config.models.find((candidate) => candidate.id === model);
    const configuredCap = positiveInt(this.config.contextWindow, DEFAULTS.contextWindow);
    const modelWindow = known?.contextWindow ?? DEFAULTS.contextWindow;
    const contextWindow = Math.min(modelWindow, configuredCap);
    const baseMaxTokens = known?.maxTokens ?? 65_536;
    const maxTokens = contextWindow <= 200_000 ? Math.min(baseMaxTokens, 32_768) : baseMaxTokens;
    return Promise.resolve({
      provider,
      id: model,
      name: known?.name ?? model,
      ...(known?.description === undefined ? {} : { description: known.description }),
      inputModalities: known?.input ?? [...DEFAULT_MODALITIES],
      context: { contextWindow },
      defaultMaxTokens: maxTokens,
    });
  }

  /**
   * Bind exact metadata and dispatch to one stream.
   *
   * @param {string} provider - the registered route id.
   * @param {string} model - requested model id.
   * @returns {Promise<{model: any, stream: (options: any) => AsyncIterable<any>}>} a one-generation call.
   */
  async prepareCall(provider, model) {
    const resolved = await this.resolveModel(provider, model);
    return { model: resolved, stream: (options) => this.stream(options) };
  }

  /**
   * Stream one Gemini response.
   *
   * @param {any} options - GenerateOptions from the harness.
   * @returns {AsyncIterable<any>} Harness chunks.
   */
  async *stream(options) {
    let emitted = false;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        for await (const chunk of streamVertex(this.config, options, this.logger, attempt, this.attachments)) {
          emitted = true;
          yield chunk;
        }
        return;
      } catch (error) {
        // Nothing reached the conversation yet, so re-issuing the call is safe.
        if (attempt === 1 && !emitted && error?.code === 'TIMEOUT') {
          this.logger?.warn?.(
            `llm-vertex: no output within ${this.config.silenceRetryMs}ms (model=${options.model}); retrying once.`,
          );
          continue;
        }
        throw error;
      }
    }
  }
}

/**
 * Probe the configured credential, project, and location without calling a model.
 *
 * @param {any} config - normalized plugin configuration.
 * @returns {Promise<{credentialPath: string, projectId: string, location: string, kind: string}>} diagnostics.
 */
export async function describeTarget(config) {
  const credentialPath = config.credentialPath.length > 0 ? config.credentialPath : defaultCredentialPath();
  const { type, raw } = readCredential(credentialPath);
  return {
    credentialPath,
    projectId: resolveProject(raw, config.projectId),
    location: validateLocation(config.location),
    kind: type,
  };
}

/**
 * Mount the plugin: validate configuration, then register the provider route.
 *
 * @param {any} ctx - the plugin's Cordis context.
 * @param {unknown} rawConfig - the Loader row configuration.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig, ctx.logger);
  const adapter = new VertexAdapter(config, ctx.logger);
  // The attachment store mounts at its own time; resolve it lazily per call.
  adapter.attachments = () => ctx.get('attachments');

  // Clear in-memory OAuth tokens when the plugin is unloaded/reloaded.
  if (typeof ctx.on === 'function') {
    ctx.on('dispose', () => {
      clearTokenCache();
    });
  }

  // A missing credential file must not prevent the route from registering:
  // listing models stays available and the first call reports the real problem.
  try {
    const target = describeTarget(config);
    void target.then((facts) =>
      ctx.logger?.info?.(
        `llm-vertex: provider "${PROVIDER}" ready (project ${facts.projectId}, location ${facts.location}, ${facts.kind} credential)`,
      ),
    ).catch((error) => {
      ctx.logger?.warn?.(`llm-vertex: ${error instanceof Error ? error.message : String(error)}`);
    });
  } catch (error) {
    ctx.logger?.warn?.(`llm-vertex: ${error instanceof Error ? error.message : String(error)}`);
  }

  ctx.llm.registerAdapter([PROVIDER], adapter);

  // The settings page talks to the host over its own HTTP routes: third-party
  // plugins cannot add `remote` RPC namespaces, and the Web server is optional.
  installAdmin(ctx, () => adapter.config, (nextConfig) => {
    adapter.config = nextConfig;
  });
}

// The Loader may take the default export as the plugin object, so the service
// requirements must travel on it as well as on the module namespace.
apply.inject = inject;

export { PROVIDER, VertexError, projectConversation };

export default apply;
