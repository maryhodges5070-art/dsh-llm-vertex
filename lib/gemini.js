/**
 * Vertex AI Gemini transport: request projection, SSE decoding, and the
 * translation into the Harness StreamChunk vocabulary.
 */
import {
  VertexError,
  defaultCredentialPath,
  forgetToken,
  getAccessToken,
  readCredential,
  redactSensitive,
  resolveProject,
  safeErrorMessage,
} from './auth.js';
import { acquireLimit } from './limit.js';
import { journal } from './journal.js';
import { recallSignature, rememberSignature, signatureDir } from './signatures.js';
import { request } from './transport.js';

const USER_AGENT = 'deepseek-harness-vertex/0.1.0 (+https://github.com/deepseek-ai/deepseek-harness)';

/**
 * Strict format check and explicit region-to-host mapping for Vertex AI locations.
 * `endpoint()` resolves the hostname exclusively from this map and never interpolates
 * raw configuration strings into a hostname.
 */
const LOCATION_PATTERN = /^[a-z0-9-]{1,40}$/u;

const KNOWN_REGION_HOSTS = Object.freeze({
  global: 'aiplatform.googleapis.com',
  'us-central1': 'us-central1-aiplatform.googleapis.com',
  'us-east1': 'us-east1-aiplatform.googleapis.com',
  'us-east4': 'us-east4-aiplatform.googleapis.com',
  'us-east5': 'us-east5-aiplatform.googleapis.com',
  'us-south1': 'us-south1-aiplatform.googleapis.com',
  'us-west1': 'us-west1-aiplatform.googleapis.com',
  'us-west2': 'us-west2-aiplatform.googleapis.com',
  'us-west3': 'us-west3-aiplatform.googleapis.com',
  'us-west4': 'us-west4-aiplatform.googleapis.com',
  'northamerica-northeast1': 'northamerica-northeast1-aiplatform.googleapis.com',
  'northamerica-northeast2': 'northamerica-northeast2-aiplatform.googleapis.com',
  'southamerica-east1': 'southamerica-east1-aiplatform.googleapis.com',
  'southamerica-west1': 'southamerica-west1-aiplatform.googleapis.com',
  'europe-central2': 'europe-central2-aiplatform.googleapis.com',
  'europe-north1': 'europe-north1-aiplatform.googleapis.com',
  'europe-southwest1': 'europe-southwest1-aiplatform.googleapis.com',
  'europe-west1': 'europe-west1-aiplatform.googleapis.com',
  'europe-west2': 'europe-west2-aiplatform.googleapis.com',
  'europe-west3': 'europe-west3-aiplatform.googleapis.com',
  'europe-west4': 'europe-west4-aiplatform.googleapis.com',
  'europe-west6': 'europe-west6-aiplatform.googleapis.com',
  'europe-west8': 'europe-west8-aiplatform.googleapis.com',
  'europe-west9': 'europe-west9-aiplatform.googleapis.com',
  'europe-west12': 'europe-west12-aiplatform.googleapis.com',
  'asia-east1': 'asia-east1-aiplatform.googleapis.com',
  'asia-east2': 'asia-east2-aiplatform.googleapis.com',
  'asia-northeast1': 'asia-northeast1-aiplatform.googleapis.com',
  'asia-northeast2': 'asia-northeast2-aiplatform.googleapis.com',
  'asia-northeast3': 'asia-northeast3-aiplatform.googleapis.com',
  'asia-south1': 'asia-south1-aiplatform.googleapis.com',
  'asia-south2': 'asia-south2-aiplatform.googleapis.com',
  'asia-southeast1': 'asia-southeast1-aiplatform.googleapis.com',
  'asia-southeast2': 'asia-southeast2-aiplatform.googleapis.com',
  'australia-southeast1': 'australia-southeast1-aiplatform.googleapis.com',
  'australia-southeast2': 'australia-southeast2-aiplatform.googleapis.com',
  'me-central1': 'me-central1-aiplatform.googleapis.com',
  'me-central2': 'me-central2-aiplatform.googleapis.com',
  'me-west1': 'me-west1-aiplatform.googleapis.com',
  'africa-south1': 'africa-south1-aiplatform.googleapis.com',
});

export const VALID_LOCATIONS = Object.freeze(Object.keys(KNOWN_REGION_HOSTS));

/**
 * Validate a Vertex AI location against the strict format and known region allowlist.
 *
 * @param {unknown} location - candidate location string.
 * @returns {string} the validated canonical location key.
 * @throws {VertexError} when the location is malformed or not in the known region list.
 */
export function validateLocation(location) {
  const value = typeof location === 'string' ? location.trim() : '';
  if (!LOCATION_PATTERN.test(value) || !Object.prototype.hasOwnProperty.call(KNOWN_REGION_HOSTS, value)) {
    throw new VertexError(
      `Invalid Vertex AI location "${redactSensitive(value)}": must match /^[a-z0-9-]{1,40}$/ and be a known Google Cloud Vertex region (e.g. global, us-central1).`,
      'INVALID_LOCATION',
    );
  }
  return value;
}

/**
 * Validate an optional baseUrl override.
 * Only `https://*.googleapis.com` is accepted by default, plus local loopback
 * proxies (`http(s)://127.0.0.1` or `http(s)://localhost`) which emit an explicit warning.
 *
 * @param {unknown} rawBaseUrl - candidate baseUrl string.
 * @param {{warn?: (msg: string) => void}} [logger] - optional logger for loopback warnings.
 * @returns {string} normalized baseUrl without trailing slash, or '' when empty.
 * @throws {VertexError} when baseUrl uses an untrusted scheme, host, or credentials.
 */
export function validateBaseUrl(rawBaseUrl, logger) {
  if (rawBaseUrl === undefined || rawBaseUrl === null) return '';
  const trimmed = typeof rawBaseUrl === 'string' ? rawBaseUrl.trim() : String(rawBaseUrl).trim();
  if (trimmed.length === 0) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new VertexError('Invalid Vertex AI baseUrl: must be a valid URL.', 'INVALID_BASE_URL');
  }
  if (parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== '') {
    throw new VertexError(
      'Invalid Vertex AI baseUrl: credentials, query parameters, and fragments are not allowed.',
      'INVALID_BASE_URL',
    );
  }
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === '127.0.0.1' || host === 'localhost';
  const isGoogleApis = host.endsWith('.googleapis.com') && host.length > '.googleapis.com'.length && /^[a-z0-9.-]+$/u.test(host);

  if (parsed.protocol === 'https:' && isGoogleApis) {
    return trimmed.replace(/\/+$/u, '');
  }
  if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && isLoopback) {
    const warnMsg = `llm-vertex: using local loopback baseUrl (${parsed.origin}); OAuth bearer tokens will be sent to this local proxy.`;
    if (typeof logger?.warn === 'function') {
      logger.warn(warnMsg);
    } else {
      process.emitWarning(warnMsg, { code: 'VERTEX_LOOPBACK_BASE_URL' });
    }
    return trimmed.replace(/\/+$/u, '');
  }
  throw new VertexError(
    'Invalid Vertex AI baseUrl: must use https: with a *.googleapis.com host (or http://127.0.0.1 / http://localhost for a local proxy).',
    'INVALID_BASE_URL',
  );
}

const CONTEXT_WINDOW_ALIASES = Object.freeze({
  '200k': 200_000,
  '512k': 512_000,
  '1m': 1_048_576,
});

export const MIN_CONTEXT_WINDOW = 200_000;
export const MAX_CONTEXT_WINDOW = 1_048_576;

/**
 * Validate an optional context window cap (between 200K and 1M tokens).
 * Accepts numeric token counts in `[200_000, 1_048_576]` or shorthand strings
 * (`"200K"`, `"512K"`, `"1M"`). Empty/undefined falls back to `1_048_576` (1M).
 *
 * @param {unknown} rawContextWindow - candidate contextWindow setting.
 * @returns {number} validated token limit in `[200_000, 1_048_576]`.
 * @throws {VertexError} when the value is outside `[200_000, 1_048_576]`.
 */
export function validateContextWindow(rawContextWindow) {
  if (rawContextWindow === undefined || rawContextWindow === null || rawContextWindow === '') {
    return MAX_CONTEXT_WINDOW;
  }
  if (typeof rawContextWindow === 'string') {
    const trimmed = rawContextWindow.trim().toLowerCase();
    if (trimmed.length === 0) return MAX_CONTEXT_WINDOW;
    if (Object.prototype.hasOwnProperty.call(CONTEXT_WINDOW_ALIASES, trimmed)) {
      return CONTEXT_WINDOW_ALIASES[trimmed];
    }
  }
  const parsed = typeof rawContextWindow === 'number' ? rawContextWindow : Number(rawContextWindow);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CONTEXT_WINDOW || parsed > MAX_CONTEXT_WINDOW) {
    throw new VertexError(
      `Invalid Vertex AI contextWindow "${redactSensitive(String(rawContextWindow))}": must be an integer between ${MIN_CONTEXT_WINDOW} (200K) and ${MAX_CONTEXT_WINDOW} (1M).`,
      'INVALID_CONTEXT_WINDOW',
    );
  }
  return parsed;
}

/**
 * Default catalog advertised by `listModels()`. Callers may still request any
 * publisher model id explicitly; `resolveModel()` accepts arbitrary Gemini ids.
 */
const DEFAULTS = {
  location: 'global',
  contextWindow: MAX_CONTEXT_WINDOW,
  timeoutMs: 300_000,
  // Response headers can take minutes on a cold model; the idle budget above
  // only covers the streaming phase once the stream is open.
  firstByteTimeoutMs: 180_000,
  // A reasoning model can sit silent after the response opens before its first
  // token arrives; that is slower than a normal stream gap, so it gets its own
  // budget. The idle budget below then covers gaps between later chunks.
  firstTokenTimeoutMs: 300_000,
  // The first attempt gets a shorter silence budget so a stalled request is
  // retried quickly; the retry then uses firstTokenTimeoutMs.
  silenceRetryMs: 120_000,
  requestsPerMinute: 60,
  maxConcurrent: 4,
  // A request that cannot get a limiter slot fails instead of waiting forever.
  acquireTimeoutMs: 30_000,
  maxToolResultChars: 0,
  redactToolResults: false,
  models: [
    {
      id: 'gemini-3.1-pro-preview',
      name: 'Gemini 3.1 Pro Preview (Vertex AI)',
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      description: 'Google Gemini 3.1 Pro Preview via Vertex AI.',
    },
    {
      id: 'gemini-3-flash-preview',
      name: 'Gemini 3 Flash Preview (Vertex AI)',
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      description: 'Google Gemini 3 Flash Preview via Vertex AI.',
    },
    {
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro (Vertex AI)',
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      description: 'Google Gemini 2.5 Pro via Vertex AI.',
    },
    {
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash (Vertex AI)',
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      description: 'Google Gemini 2.5 Flash via Vertex AI.',
    },
  ],
};

/**
 * Build the regional Vertex AI `streamGenerateContent` URL.
 *
 * The `global` location lives on the bare `aiplatform.googleapis.com` host;
 * regional endpoints live on `https://<region>-aiplatform.googleapis.com` resolved
 * strictly from the `KNOWN_REGION_HOSTS` lookup table.
 *
 * @param {{baseUrl?: string, projectId: string, location: string, model: string}} target - call target.
 * @returns {string} the full SSE endpoint URL.
 */
function endpoint(target) {
  const location = validateLocation(target.location);
  const host = KNOWN_REGION_HOSTS[location];
  const base = typeof target.baseUrl === 'string' && target.baseUrl.length > 0
    ? validateBaseUrl(target.baseUrl)
    : `https://${host}`;
  const project = encodeURIComponent(target.projectId);
  const locSegment = encodeURIComponent(location);
  const model = encodeURIComponent(target.model);
  return `${base}/v1/projects/${project}/locations/${locSegment}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;
}

/**
 * Project a Harness conversation into a Vertex Gemini request body.
 *
 * Rules required by Gemini's multi-turn tool calling contract:
 *  - Consecutive turns of the same Gemini role (`user` or `model`) are merged.
 *  - Every `tool` result becomes a `functionResponse` part in a `user` turn,
 *    carrying the name of the preceding `tool-call` with the same `toolCallId`.
 *  - Gemini 3/4 requires every replayed `functionCall` to carry the
 *    `thoughtSignature` it arrived with. When a historical call has no stored
 *    signature (for example, the turn came from another provider before the
 *    user switched models), both the call and its response are omitted so
 *    Vertex does not reject the whole conversation with HTTP 400.
 *  - Every kept `functionCall` turn must be followed immediately by a `user`
 *    turn whose `functionResponse` parts match the calls 1-for-1 in order; missing
 *    results are padded with a synthetic cancellation response and orphan
 *    responses are dropped.
 *
 * @param { ReadonlyArray<any> } messages - Harness messages.
 * @param {string | undefined} systemPrompt - optional top-level system prompt.
 * @param {{sessionId?: string, signatureDir?: string, maxToolResultChars?: number, redactToolResults?: boolean}} [memory] - signature lookup context & tool output policy.
 * @returns {{contents: any[], systemInstruction?: {parts: {text: string}[]}}} Gemini payload sections.
 */
export function projectConversation(messages, systemPrompt, memory = {}) {
  const systemParts = [];
  if (typeof systemPrompt === 'string' && systemPrompt.trim().length > 0) {
    systemParts.push({ text: systemPrompt });
  }

  const sigDir = signatureDir(memory.signatureDir);
  const sessionId = memory.sessionId;
  const maxToolResultChars = typeof memory.maxToolResultChars === 'number' && memory.maxToolResultChars > 0
    ? Math.trunc(memory.maxToolResultChars)
    : 0;
  const redactToolResults = memory.redactToolResults === true;
  /** @type {Map<string, {mimeType: string, data: string}>} */
  const images = memory.images instanceof Map ? memory.images : new Map();

  // Pass 1: collect every assistant tool-call and whether it has a signature.
  // When Gemini 3/4 streams parallel functionCalls in a single turn, it attaches
  // `thoughtSignature` only to the first functionCall part. Sibling tool-calls
  // in the same assistant turn inherit `turnSignature` so none are dropped.
  /** @type {Map<string, {name: string, args: Record<string, unknown>, signature: string | undefined}>} */
  const callIndex = new Map();
  for (const message of messages ?? []) {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    /** @type {Array<{id: string, name: string, args: Record<string, unknown>, signature: string | undefined}>} */
    const turnCalls = [];
    let turnSignature;
    for (const block of message.content) {
      if (typeof block?.thoughtSignature === 'string' && block.thoughtSignature.length > 0 && turnSignature === undefined) {
        turnSignature = block.thoughtSignature;
      }
      if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') {
        const inline = typeof block.thoughtSignature === 'string' && block.thoughtSignature.length > 0
          ? block.thoughtSignature
          : undefined;
        const signature = inline ?? recallSignature(sigDir, sessionId, block.id);
        if (signature !== undefined && turnSignature === undefined) {
          turnSignature = signature;
        }
        turnCalls.push({ id: block.id, name: block.name, args: parseToolArgs(block.arguments), signature });
      }
    }
    for (const entry of turnCalls) {
      callIndex.set(entry.id, {
        name: entry.name,
        args: entry.args,
        signature: entry.signature ?? turnSignature,
      });
    }
  }

  // Pass 2: build turns, skipping unsigned functionCalls and collecting tool
  // responses by id so each call turn can be paired cleanly.
  /** @type {Map<string, {name: string, response: Record<string, unknown>}>} */
  const responsesById = new Map();
  /** @type {Map<string, Array<{inlineData: {mimeType: string, data: string}}>>} */
  const toolImagesById = new Map();
  for (const message of messages ?? []) {
    if (message?.role !== 'tool') continue;
    const call = callIndex.get(message.toolCallId);
    if (call === undefined || call.signature === undefined) continue;
    let outputText = collectToolText(message.content);
    if (redactToolResults) {
      outputText = redactSensitive(outputText);
    }
    if (maxToolResultChars > 0 && outputText.length > maxToolResultChars) {
      outputText = `${outputText.slice(0, maxToolResultChars)}…[truncated]`;
    }
    responsesById.set(message.toolCallId, {
      name: call.name,
      response: message.isError === true ? { error: outputText } : { result: outputText },
    });
    const inlineParts = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block?.type === 'image' && block.offloaded !== true) {
        const inline = images.get(block.attachment?.attachmentId);
        if (inline !== undefined) inlineParts.push({ inlineData: inline });
      }
    }
    if (inlineParts.length > 0) toolImagesById.set(message.toolCallId, inlineParts);
  }

  const contents = [];
  const hasResponsePart = (parts) => parts.some((part) => part.functionResponse !== undefined);
  const pushParts = (role, parts) => {
    if (parts.length === 0) return;
    const previous = contents[contents.length - 1];
    // Vertex rejects a turn that carries tool results AND plain text together
    // (it reports the misleading "ending with a model turn" error), so tool
    // results always stay alone in their own turn and later text starts a new
    // one. Consecutive user turns are accepted by the API.
    const sameRole = previous !== undefined && previous.role === role;
    const mergeable = sameRole
      && (role !== 'user' || hasResponsePart(previous.parts) === hasResponsePart(parts));
    if (mergeable) {
      previous.parts.push(...parts);
    } else {
      contents.push({ role, parts: [...parts] });
    }
  };

  for (const message of messages ?? []) {
    if (message === null || typeof message !== 'object') continue;
    if (message.role === 'system') {
      const text = collectText(message.content);
      if (text.length > 0) systemParts.push({ text });
      continue;
    }
    if (message.role === 'user') {
      const parts = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          parts.push({ text: block.text });
        } else if (block?.type === 'image' && block.offloaded !== true) {
          const inline = images.get(block.attachment?.attachmentId);
          if (inline !== undefined) parts.push({ inlineData: inline });
        }
      }
      pushParts('user', parts);
      continue;
    }
    if (message.role === 'assistant') {
      const textParts = [];
      const callIds = [];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          textParts.push({ text: block.text });
        } else if (block?.type === 'tool-call' && typeof block.id === 'string') {
          const call = callIndex.get(block.id);
          if (call?.signature !== undefined) callIds.push(block.id);
        }
      }
      pushParts('model', textParts);
      if (callIds.length > 0) {
        const callParts = callIds.map((id) => {
          const call = callIndex.get(id);
          return {
            functionCall: { name: call.name, args: call.args },
            thoughtSignature: call.signature,
          };
        });
        pushParts('model', callParts);
        const responseParts = callIds.map((id) => {
          const found = responsesById.get(id);
          if (found !== undefined) return { functionResponse: found };
          const call = callIndex.get(id);
          return {
            functionResponse: {
              name: call.name,
              response: { error: 'Tool call did not complete before the next turn.' },
            },
          };
        });
        contents.push({ role: 'user', parts: responseParts });
        // Gemini has no place for media inside a functionResponse, so tool
        // images follow in their own user turn (consecutive user turns are valid).
        const imageParts = callIds.flatMap((id) => toolImagesById.get(id) ?? []);
        if (imageParts.length > 0) {
          contents.push({
            role: 'user',
            parts: [{ text: 'Images returned by the tools above:' }, ...imageParts],
          });
        }
      }
      continue;
    }
    // `tool` messages are emitted immediately after their owning `assistant`
    // call batch above so parallel calls and out-of-order history stay valid.
  }

  // A history that ends on an assistant turn (a stopped response, or a replay
  // of the previous answer) is rejected by Vertex. Ask the model to continue.
  const last = contents[contents.length - 1];
  if (last !== undefined && last.role === 'model') {
    contents.push({ role: 'user', parts: [{ text: 'Continue from where you left off.' }] });
  }

  return {
    contents,
    ...(systemParts.length > 0 ? { systemInstruction: { parts: systemParts } } : {}),
  };
}

/**
 * Convert Harness tool definitions into a Gemini `functionDeclarations` list.
 *
 * Gemini's OpenAPI-subset schema rejects `$schema` and `additionalProperties`
 * in several positions and requires an upper-case or standard JSON-schema
 * `type`; we strip unsupported keywords recursively while preserving structure.
 *
 * @param {ReadonlyArray<any> | undefined} tools - Harness tool definitions.
 * @returns {any[] | undefined} Gemini functionDeclarations, or undefined when empty.
 */
export function projectTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  const declarations = [];
  for (const tool of tools) {
    if (tool === null || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name.length === 0) continue;
    const cleaned = cleanSchema(tool.parameters);
    declarations.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      ...(cleaned !== undefined ? { parameters: cleaned } : {}),
    });
  }
  return declarations.length > 0 ? declarations : undefined;
}

const DROPPED_SCHEMA_KEYS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'definitions',
  'additionalProperties',
  'unevaluatedProperties',
  'patternProperties',
  'examples',
  'default',
  'const',
  'strict',
]);

/**
 * Strip JSON-Schema keywords that Vertex AI's `Schema` proto rejects.
 *
 * @param {unknown} schema - raw tool parameter schema.
 * @returns {Record<string, unknown> | undefined} cleaned schema.
 */
function cleanSchema(schema) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return undefined;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === 'type' && Array.isArray(value)) {
      const nonNull = value.find((item) => item !== 'null');
      if (typeof nonNull === 'string') out.type = nonNull;
      if (value.includes('null')) out.nullable = true;
      continue;
    }
    if (key === 'properties' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      /** @type {Record<string, unknown>} */
      const props = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        const cleaned = cleanSchema(propSchema);
        if (cleaned !== undefined) props[propName] = cleaned;
      }
      out.properties = props;
      continue;
    }
    if (key === 'items' && value !== null && typeof value === 'object') {
      const cleaned = cleanSchema(value);
      if (cleaned !== undefined) out.items = cleaned;
      continue;
    }
    if ((key === 'anyOf' || key === 'oneOf') && Array.isArray(value)) {
      const branches = value.map(cleanSchema).filter((item) => item !== undefined);
      if (branches.length > 0) out.anyOf = branches;
      continue;
    }
    out[key] = value;
  }
  if (out.type === 'object' && out.properties === undefined) {
    out.properties = {};
  }
  return out;
}

/**
 * Parse a Harness tool-call `arguments` JSON string into an object for Gemini.
 *
 * @param {unknown} raw - JSON string or pre-parsed object.
 * @returns {Record<string, unknown>} an object suitable for `functionCall.args`.
 */
function parseToolArgs(raw) {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return /** @type {Record<string, unknown>} */ (raw);
  if (typeof raw !== 'string' || raw.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

/**
 * @param {unknown} content - message content array.
 * @returns {string} concatenated text blocks.
 */
function collectText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/**
 * @param {unknown} content - tool result content array.
 * @returns {string} flattened textual representation for `functionResponse`.
 */
function collectToolText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block !== null && typeof block === 'object') {
      parts.push(JSON.stringify(block));
    }
  }
  return parts.join('\n');
}

/**
 * Build the `generationConfig` section of a Gemini request.
 *
 * @param {Record<string, unknown>} options - Harness GenerateOptions.
 * @returns {Record<string, unknown>} generationConfig object.
 */
function buildGenerationConfig(options) {
  /** @type {Record<string, unknown>} */
  const config = {};
  if (typeof options.maxTokens === 'number' && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
    config.maxOutputTokens = Math.trunc(options.maxTokens);
  }
  if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) {
    config.temperature = options.temperature;
  }
  if (typeof options.topP === 'number' && Number.isFinite(options.topP)) {
    config.topP = options.topP;
  }
  if (Array.isArray(options.stopSequences) && options.stopSequences.length > 0) {
    config.stopSequences = options.stopSequences.filter((item) => typeof item === 'string');
  }
  const effort = options.reasoningEffort;
  if (typeof effort === 'string' && effort.length > 0 && effort !== 'none') {
    const model = typeof options.model === 'string' ? options.model : '';
    if (model.startsWith('gemini-3')) {
      const level = effort === 'low' ? 'LOW' : effort === 'medium' ? 'MEDIUM' : 'HIGH';
      config.thinkingConfig = { includeThoughts: true, thinkingLevel: level };
    } else {
      const budget = effort === 'low' ? 1024 : effort === 'medium' ? 8192 : 24576;
      config.thinkingConfig = { includeThoughts: true, thinkingBudget: budget };
    }
  }
  return config;
}

/** Longest edge, in pixels, requested for an inline image. */
const IMAGE_LONG_EDGE = 2_048;

/** Encoded-byte ceiling for one inline image. */
const IMAGE_MAX_BYTES = 4_000_000;

/**
 * Describe the request version of one image attachment.
 *
 * @param {any} ref - the attachment reference carried by an image block.
 * @returns {{width: number, height: number, maxBytes: number}} target dimensions.
 */
export function imageTarget(ref) {
  const width = Number.isFinite(ref?.width) && ref.width > 0 ? ref.width : 1_024;
  const height = Number.isFinite(ref?.height) && ref.height > 0 ? ref.height : 1_024;
  const scale = Math.min(1, IMAGE_LONG_EDGE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    maxBytes: IMAGE_MAX_BYTES,
  };
}

/**
 * Read every retained image in the request history into inline base64 parts.
 *
 * @param {any} messages - Harness request messages.
 * @param {any} attachments - the host attachment store, if mounted.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<Map<string, {mimeType: string, data: string}>>} id → inline part.
 */
export async function collectImages(messages, attachments, signal) {
  /** @type {Map<string, any>} */
  const refs = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) {
      if (block?.type !== 'image' || block.offloaded === true) continue;
      const id = block.attachment?.attachmentId;
      if (id !== undefined && id !== null) refs.set(String(id), block.attachment);
    }
  }
  /** @type {Map<string, {mimeType: string, data: string}>} */
  const images = new Map();
  if (refs.size === 0) return images;
  if (attachments === undefined || attachments === null || typeof attachments.readImageRequest !== 'function') {
    throw new VertexError(
      'This model accepts images, but the host attachment service is unavailable in this profile.',
      'UNSUPPORTED_CONTENT',
    );
  }
  for (const [id, ref] of refs) {
    const version = await attachments.readImageRequest(ref, imageTarget(ref), signal);
    images.set(id, {
      mimeType: version.mediaType,
      data: Buffer.from(version.data).toString('base64'),
    });
  }
  return images;
}

/**
 * Stream a Gemini completion from Vertex AI and yield Harness StreamChunks.
 *
 * @param {any} pluginConfig - normalized plugin configuration.
 * @param {any} options - Harness GenerateOptions.
 * @param {any} [logger] - optional logger for debug-only redacted diagnostics.
 * @returns {AsyncGenerator<any, void, void>} stream of Harness chunks.
 */
export async function* streamVertex(pluginConfig, options, logger, attempt = 1, attachments) {
  const credentialFile = pluginConfig.credentialPath.length > 0
    ? pluginConfig.credentialPath
    : defaultCredentialPath();
  const credential = readCredential(credentialFile);
  const projectId = resolveProject(credential.raw, pluginConfig.projectId);
  const location = validateLocation(pluginConfig.location);
  const baseUrl = validateBaseUrl(pluginConfig.baseUrl, logger);
  const sigDir = pluginConfig.signatureDir || signatureDir();
  const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined;
  const images = await collectImages(options.messages, typeof attachments === 'function' ? attachments() : attachments, options.signal);

  const { contents, systemInstruction } = projectConversation(options.messages, options.systemPrompt, {
    sessionId,
    signatureDir: sigDir,
    maxToolResultChars: pluginConfig.maxToolResultChars,
    redactToolResults: pluginConfig.redactToolResults,
    images,
  });
  if (contents.length === 0) {
    throw new VertexError('Vertex AI request contains no user or model turns to send.', 'EMPTY_CONVERSATION');
  }

  const declarations = projectTools(options.tools);
  const generationConfig = buildGenerationConfig(options);
  /** @type {Record<string, unknown>} */
  const body = {
    contents,
    ...(systemInstruction !== undefined ? { systemInstruction } : {}),
    ...(declarations !== undefined ? { tools: [{ functionDeclarations: declarations }] } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };

  const url = endpoint({
    baseUrl,
    projectId,
    location,
    model: options.model,
  });

  const startedAt = Date.now();
  journal(
    `req model=${options.model} loc=${location} attempt=${attempt} msgs=${contents.length} `
    + `tools=${declarations?.length ?? 0} body=${Buffer.byteLength(JSON.stringify(body))}B `
    + `proxy=${pluginConfig.proxyUrl.length > 0 ? 'on' : 'direct'}`,
  );

  const controller = new AbortController();
  // Idle timeout instead of a total budget: a long generation may stream for
  // many minutes as long as data keeps arriving; only a silent stall aborts.
  let idleTimer;
  let streamBody = null;
  let armIdle = (limitMs, phase) => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(new VertexError(
        `Vertex AI sent no ${phase} for ${limitMs}ms (model=${options.model}, location=${location}); the request was aborted.`,
        'TIMEOUT',
      )),
      limitMs,
    );
  };
  const onCallerAbort = () => controller.abort(options.signal?.reason);
  if (options.signal !== undefined) {
    if (options.signal.aborted) controller.abort(options.signal.reason);
    else options.signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    const tokenOptions = { proxyUrl: pluginConfig.proxyUrl, tokenUrl: pluginConfig.tokenUrl, timeoutMs: pluginConfig.timeoutMs };
    let token = await getAccessToken(credentialFile, credential, controller.signal, logger, tokenOptions);
    const withModelContext = async (call) => {
      try {
        return await call();
      } catch (error) {
        if (error instanceof VertexError && error.code === 'TIMEOUT') {
          throw new VertexError(
            `Vertex AI did not send response headers within ${pluginConfig.firstByteTimeoutMs}ms (model=${options.model}, location=${location}). `
            + 'The model may be cold-starting, queued, or unavailable in this project/region; '
            + 'test it in 设置 → Vertex AI → 模型清单, or raise firstByteTimeoutMs.',
            'TIMEOUT',
          );
        }
        throw error;
      }
    };
    let response = await withModelContext(() => postStream(url, token, body, controller.signal, pluginConfig));
    journal(`hdr status=${response.status} in ${Date.now() - startedAt}ms`);
    if (response.status === 401) {
      await response.body?.cancel?.().catch(() => {});
      forgetToken(credentialFile);
      token = await getAccessToken(credentialFile, credential, controller.signal, logger, tokenOptions);
      response = await withModelContext(() => postStream(url, token, body, controller.signal, pluginConfig));
      journal(`hdr retry status=${response.status} in ${Date.now() - startedAt}ms`);
    }
    streamBody = response.body;
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger?.debug?.(
        `llm-vertex: upstream HTTP ${response.status} (${options.model} in ${location}): ${redactSensitive(errorText)}`,
      );
      const retryAfterMs = parseRetryDelayMs(response, errorText);
      const summary = safeErrorMessage(errorText, `HTTP ${response.status}`);
      if (response.status === 400) {
        // Vertex is picky about turn shape; record the shape (never the text)
        // so a rejected request can be reconstructed from debug.log alone.
        const tailParts = (contents[contents.length - 1]?.parts ?? []).map((part) => Object.keys(part).join('+'));
        journal(`bad400 roles=${contents.map((turn) => turn.role).join(',')} tail=${tailParts.join('|')}`);
      }
      throw new VertexError(
        `Vertex AI rejected the request (HTTP ${response.status}, model=${options.model}, location=${location}): ${summary}`,
        `HTTP_${response.status}`,
        retryAfterMs !== undefined ? { providerRetryAfterMs: retryAfterMs } : undefined,
      );
    }
    if (response.body === null) {
      throw new VertexError('Vertex AI response had no readable stream body.', 'EMPTY_RESPONSE_BODY');
    }
    // Headers are in; now the model may think silently before the first token.
    armIdle(attempt === 1 ? pluginConfig.silenceRetryMs : pluginConfig.firstTokenTimeoutMs, 'first token');
    let sawFirstEvent = false;
    const markEvent = () => {
      if (sawFirstEvent) {
        armIdle(pluginConfig.timeoutMs, 'data');
        return;
      }
      sawFirstEvent = true;
      journal(`token in ${Date.now() - startedAt}ms`);
      armIdle(pluginConfig.timeoutMs, 'data');
    };

    let callSeq = 0;
    let sawToolCall = false;
    let finishReason;
    let usage;
    let turnThoughtSignature;

    // Chunk protocol: every delta carries a block index; text/reasoning deltas
    // share their block's index, and each block is wrapped in start/end so the
    // Harness accumulator can rebuild it without guessing boundaries.
    let blockIndex = 0;
    let openBlock = null;

    const closeOpenBlock = function* () {
      if (openBlock === null) return;
      const { index, blockType, text } = openBlock;
      openBlock = null;
      yield { type: 'block-end', index, block: { type: blockType, text } };
    };

    const pushDelta = function* (blockType, text) {
      if (openBlock !== null && openBlock.blockType !== blockType) {
        yield* closeOpenBlock();
      }
      if (openBlock === null) {
        openBlock = { index: blockIndex, blockType, text: '' };
        blockIndex += 1;
        yield { type: 'block-start', index: openBlock.index, blockType };
      }
      openBlock.text += text;
      yield {
        type: blockType === 'text' ? 'text-delta' : 'reasoning-delta',
        index: openBlock.index,
        text,
      };
    };

    for await (const frame of readSseFrames(response.body)) {
      // Comments and keep-alives are not tokens: only a real data event ends the
      // first-token phase.
      markEvent();
      let payload;
      try {
        payload = JSON.parse(frame);
      } catch {
        continue;
      }
      if (payload?.error !== undefined) {
        logger?.debug?.(`llm-vertex: SSE stream error payload: ${redactSensitive(frame)}`);
        const summary = safeErrorMessage(frame, 'stream error');
        throw new VertexError(
          `Vertex AI stream error: ${summary}`,
          String(payload.error.status ?? payload.error.code ?? 'STREAM_ERROR'),
        );
      }
      if (payload?.usageMetadata !== undefined) {
        const meta = payload.usageMetadata;
        const inputTokens = numberOr(meta.promptTokenCount, 0);
        const candidatesTokens = numberOr(meta.candidatesTokenCount, 0);
        const thoughtsTokens = numberOr(meta.thoughtsTokenCount, 0);
        const outputTokens = candidatesTokens + thoughtsTokens;
        const totalTokens = numberOr(meta.totalTokenCount, inputTokens + outputTokens);
        const cachedInputTokens = numberOr(meta.cachedContentTokenCount, 0);
        usage = {
          inputTokens,
          outputTokens,
          totalTokens,
          ...(cachedInputTokens > 0 ? { cacheReadTokens: cachedInputTokens } : {}),
        };
      }
      const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
      for (const candidate of candidates) {
        if (typeof candidate?.finishReason === 'string' && candidate.finishReason.length > 0) {
          finishReason = candidate.finishReason;
        }
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        for (const part of parts) {
          if (typeof part?.thoughtSignature === 'string' && part.thoughtSignature.length > 0) {
            turnThoughtSignature = part.thoughtSignature;
          }
          if (part?.thought === true && typeof part.text === 'string' && part.text.length > 0) {
            yield* pushDelta('reasoning', part.text);
          } else if (typeof part?.text === 'string' && part.text.length > 0) {
            yield* pushDelta('text', part.text);
          } else if (part?.functionCall !== undefined && typeof part.functionCall.name === 'string') {
            callSeq += 1;
            sawToolCall = true;
            yield* closeOpenBlock();
            const callId = typeof part.functionCall.id === 'string' && part.functionCall.id.length > 0
              ? part.functionCall.id
              : `vertex_call_${Date.now()}_${callSeq}`;
            const effectiveSignature = typeof part.thoughtSignature === 'string' && part.thoughtSignature.length > 0
              ? part.thoughtSignature
              : turnThoughtSignature;
            if (typeof effectiveSignature === 'string' && effectiveSignature.length > 0) {
              rememberSignature(sigDir, sessionId, callId, effectiveSignature);
            }
            const name = part.functionCall.name;
            const argsText = JSON.stringify(part.functionCall.args ?? {});
            const index = blockIndex;
            blockIndex += 1;
            yield { type: 'block-start', index, blockType: 'tool-call' };
            yield { type: 'tool-call-delta', index, id: callId, name, argumentsDelta: argsText };
            yield { type: 'block-end', index, block: { type: 'tool-call', id: callId, name, arguments: argsText } };
          }
        }
      }
    }

    yield* closeOpenBlock();

    if (usage !== undefined) {
      yield { type: 'usage', usage };
    }
    journal(
      `done in ${Date.now() - startedAt}ms finish=${finishOf(finishReason, sawToolCall).kind} `
      + `in=${usage?.inputTokens ?? '?'} out=${usage?.outputTokens ?? '?'}`,
    );
    yield { type: 'finish', reason: finishOf(finishReason, sawToolCall) };
  } catch (error) {
    journal(`error ${error?.code ?? error?.name ?? 'UNKNOWN'} after ${Date.now() - startedAt}ms: ${String(error?.message ?? error).slice(0, 240)}`);
    // Aborting through the tunnel can surface as ECONNRESET on the socket
    // rather than as the abort reason; report the intended failure instead.
    if (controller.signal.aborted && controller.signal.reason instanceof VertexError) {
      throw controller.signal.reason;
    }
    throw error;
  } finally {
    clearTimeout(idleTimer);
    // Release the upstream connection (and its limiter slot) even when the
    // consumer walks away mid-stream: otherwise four abandoned turns would
    // silently block every later request.
    if (streamBody !== null) await streamBody.cancel().catch(() => {});
    if (options.signal !== undefined) {
      options.signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Decode an SSE byte stream into individual `data:` payloads.
 *
 * Handles arbitrary UTF-8 chunk boundaries, CRLF and LF line endings, and
 * multi-line `data:` events per the WHATWG EventSource specification.
 *
 * @param {ReadableStream<Uint8Array>} stream - response body stream.
 * @param {() => void} [onActivity] - called for every received chunk.
 * @returns {AsyncGenerator<string, void, void>} JSON strings from each SSE event.
 */
async function* readSseFrames(stream, onActivity) {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for await (const chunk of stream) {
    onActivity?.();
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = findEventBoundary(buffer)) !== null) {
      const rawEvent = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.length);
      const data = extractEventData(rawEvent);
      if (data !== null) yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    const data = extractEventData(buffer);
    if (data !== null) yield data;
  }
}

/**
 * Find the earliest blank-line event delimiter (`\r\n\r\n` or `\n\n`).
 *
 * @param {string} buffer - accumulated decoded text.
 * @returns {{index: number, length: number} | null} delimiter position or null.
 */
function findEventBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (lf !== -1 && (crlf === -1 || lf < crlf)) return { index: lf, length: 2 };
  return { index: crlf, length: 4 };
}

/**
 * Extract the concatenated `data:` lines from one SSE event block.
 *
 * @param {string} rawEvent - lines belonging to a single SSE event.
 * @returns {string | null} the joined payload, or null for comments/heartbeats.
 */
function extractEventData(rawEvent) {
  const dataLines = [];
  for (const line of rawEvent.split(/\r?\n/u)) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      const rest = line.slice(5);
      dataLines.push(rest.startsWith(' ') ? rest.slice(1) : rest);
    }
  }
  if (dataLines.length === 0) return null;
  const joined = dataLines.join('\n').trim();
  return joined.length > 0 && joined !== '[DONE]' ? joined : null;
}

const TRANSIENT_STATUSES = new Set([429, 503]);
const MAX_TRANSIENT_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1_500;
const MAX_RETRY_DELAY_MS = 20_000;

/**
 * Issue the HTTPS POST to Vertex AI, pacing through the in-process limiter and
 * backing off when Vertex answers with a transient 429 (`RESOURCE_EXHAUSTED`)
 * or 503 (`UNAVAILABLE`).
 *
 * @param {string} url - full regional endpoint.
 * @param {string} token - OAuth2 bearer access token.
 * @param {Record<string, unknown>} body - Gemini request payload.
 * @param {AbortSignal} signal - combined timeout + caller cancellation signal.
 * @param {any} config - normalized plugin configuration.
 * @returns {Promise<Response>} the fetch response.
 */
async function postStream(url, token, body, signal, config) {
  const payload = JSON.stringify(body);
  for (let attempt = 1; ; attempt += 1) {
    const release = await acquireLimit(config, signal);
    let response;
    try {
      response = await request(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8',
          accept: 'text/event-stream',
          'user-agent': USER_AGENT,
        },
        body: payload,
        signal,
        warn: (message) => config.logger?.warn?.(message),
        timeoutMs: config.firstByteTimeoutMs ?? config.timeoutMs,
        proxyUrl: config.proxyUrl,
      });
    } catch (error) {
      release();
      if (error instanceof VertexError) throw error;
      if (signal.aborted && signal.reason instanceof VertexError) throw signal.reason;
      throw new VertexError(
        'Vertex AI network request failed.',
        'NETWORK_ERROR',
      );
    }
    if (!TRANSIENT_STATUSES.has(response.status) || attempt >= MAX_TRANSIENT_ATTEMPTS) {
      if (response.body === null) {
        release();
        return response;
      }
      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: response.headers,
        body: guardStream(response.body, release),
        text: () => response.text(),
        clone: () => response.clone(),
      };
    }
    const hintMs = await retryDelayMs(response);
    await response.body?.cancel?.().catch(() => {});
    release();
    const backoff = Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** (attempt - 1));
    const jitter = Math.floor(Math.random() * 500);
    const delayMs = hintMs !== undefined ? Math.min(MAX_RETRY_DELAY_MS, Math.max(hintMs, 250)) : backoff + jitter;
    await sleep(delayMs, signal);
  }
}

/**
 * Hold the concurrency slot until the SSE body finishes, errors, or is cancelled.
 *
 * @param {ReadableStream<Uint8Array>} stream - upstream response body.
 * @param {() => void} release - limiter slot release callback.
 * @returns {ReadableStream<Uint8Array>} wrapped stream.
 */
function guardStream(stream, release) {
  let reader;
  let released = false;
  const once = () => {
    if (released) return;
    released = true;
    release();
  };
  return new ReadableStream({
    start() {
      reader = stream.getReader();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          once();
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        once();
        throw error;
      }
    },
    async cancel(reason) {
      once();
      await reader?.cancel(reason);
    },
  });
}

/**
 * Read a server-supplied retry delay from `Retry-After` or a Google RPC
 * `RetryInfo` detail before the body has been consumed.
 *
 * @param {Response} response - the 429 or 503 response.
 * @returns {Promise<number | undefined>} delay in milliseconds, if present.
 */
async function retryDelayMs(response) {
  const text = await response.clone().text().catch(() => '');
  return parseRetryDelayMs(response, text);
}

/**
 * Extract a server-supplied retry delay from `Retry-After` or a Google RPC
 * `RetryInfo` detail in an already-read error body.
 *
 * @param {Response} response - the error response.
 * @param {string} bodyText - response body text.
 * @returns {number | undefined} delay in milliseconds, if present.
 */
function parseRetryDelayMs(response, bodyText) {
  const header = response.headers?.get?.('retry-after');
  if (typeof header === 'string' && header.trim().length > 0) {
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  }
  try {
    const payload = JSON.parse(bodyText);
    for (const detail of payload?.error?.details ?? []) {
      const match = typeof detail?.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/u.exec(detail.retryDelay) : null;
      if (match !== null) return Number(match[1]) * 1_000;
    }
  } catch {
    // Unparseable body: fall back to local exponential backoff.
  }
  return undefined;
}

/**
 * Wait, but give up immediately when the caller aborts.
 *
 * @param {number} ms - delay in milliseconds.
 * @param {AbortSignal | undefined} signal - the request signal.
 * @returns {Promise<void>} resolves after the delay.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Map Gemini finish reasons onto the Harness vocabulary.
 *
 * @param {string | undefined} reason - Gemini finishReason.
 * @param {boolean} sawToolCall - whether any function call was streamed.
 * @returns {{kind: string, failure?: {message: string, code: string}}} the finish reason.
 */
function finishOf(reason, sawToolCall) {
  switch (reason) {
    case undefined:
    case 'STOP':
      return { kind: sawToolCall ? 'tool-calls' : 'stop' };
    case 'MAX_TOKENS':
      return { kind: 'max-tokens' };
    case 'MALFORMED_FUNCTION_CALL':
      return { kind: 'error', failure: { message: 'Gemini produced a malformed function call.', code: 'MALFORMED_TOOL_CALL' } };
    default:
      return {
        kind: 'error',
        failure: { message: `Gemini stopped the response (${reason}).`, code: 'CONTENT_FILTER' },
      };
  }
}

/**
 * @param {unknown} value - candidate counter.
 * @param {number} fallback - default when not a finite number.
 * @returns {number} a non-negative integer.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : fallback;
}

export { DEFAULTS, endpoint };
