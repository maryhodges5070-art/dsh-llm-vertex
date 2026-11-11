/**
 * Durable store for Gemini 3/4 thought signatures.
 *
 * Gemini 3/4 requires every replayed `functionCall` part to carry the
 * `thoughtSignature` that came with it, but the Harness tool-call block has no
 * slot for it. Signatures are therefore kept beside the profile, keyed by
 * session and tool-call id, and re-attached while projecting history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Current on-disk schema version for thought-signatures.json. */
export const SIGNATURE_FORMAT_VERSION = 1;
/** Maximum allowed size for thought-signatures.json on disk (8 MiB). */
export const MAX_SIGNATURE_FILE_BYTES = 8 * 1024 * 1024;
/** Maximum signatures kept per session before pruning the oldest. */
export const MAX_CALLS_PER_SESSION = 500;
/** Maximum character length for a single thoughtSignature. */
export const MAX_SIGNATURE_CHARS = 65_536;
/** How many sessions to keep before pruning the oldest. */
const MAX_SESSIONS = 200;
/** Debounce for the write-behind flush. */
const FLUSH_MS = 1_000;

/**
 * Per-directory isolated cache and flush timer:
 * normalizedDir -> { dir: string, db: Record<string, Record<string, string>>, timer?: NodeJS.Timeout }
 *
 * @type {Map<string, {dir: string, db: Record<string, Record<string, string>>, timer: NodeJS.Timeout | undefined}>}
 */
const dirStores = new Map();

/**
 * Resolve the store directory: explicit configuration, then the DSH home.
 *
 * @param {string} [configured] - `signatureDir` from the plugin configuration.
 * @returns {string} absolute directory holding the signature file.
 */
export function signatureDir(configured) {
  if (typeof configured === 'string' && configured.trim().length > 0) return configured.trim();
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.join(home, 'llm-vertex');
}

/**
 * @param {string} dir - store directory.
 * @returns {string} normalized key for the per-directory store map.
 */
function keyOf(dir) {
  return path.resolve(dir);
}

/**
 * @param {string} dir - store directory.
 * @returns {string} absolute signature file path.
 */
function fileOf(dir) {
  return path.join(dir, 'thought-signatures.json');
}

/**
 * Normalize or migrate a parsed signature file payload into a session map.
 *
 * @param {unknown} parsed - parsed JSON content from disk.
 * @returns {Record<string, Record<string, string>>} session keyed signatures.
 */
function migrateSessions(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const record = /** @type {Record<string, unknown>} */ (parsed);
  // v1+ envelope: { version: number, sessions: { [sessionId]: { [toolCallId]: string } } }
  if (typeof record.version === 'number' && record.sessions !== null && typeof record.sessions === 'object' && !Array.isArray(record.sessions)) {
    return sanitizeSessionMap(/** @type {Record<string, unknown>} */ (record.sessions));
  }
  // Legacy v0 flat map: { [sessionId]: { [toolCallId]: string } }
  return sanitizeSessionMap(record);
}

/**
 * @param {Record<string, unknown>} raw - candidate session map.
 * @returns {Record<string, Record<string, string>>} validated session map.
 */
function sanitizeSessionMap(raw) {
  /** @type {Record<string, Record<string, string>>} */
  const out = Object.create(null);
  const sessionEntries = Object.entries(raw);
  const keptSessions = sessionEntries.length > MAX_SESSIONS
    ? sessionEntries.slice(sessionEntries.length - MAX_SESSIONS)
    : sessionEntries;
  for (const [sessionId, calls] of keptSessions) {
    if (sessionId === '__proto__' || sessionId === 'constructor' || sessionId === 'prototype') continue;
    if (calls === null || typeof calls !== 'object' || Array.isArray(calls)) continue;
    /** @type {Record<string, string>} */
    const bucket = Object.create(null);
    const callEntries = Object.entries(/** @type {Record<string, unknown>} */ (calls));
    const keptCalls = callEntries.length > MAX_CALLS_PER_SESSION
      ? callEntries.slice(callEntries.length - MAX_CALLS_PER_SESSION)
      : callEntries;
    for (const [callId, sig] of keptCalls) {
      if (callId === '__proto__' || callId === 'constructor' || callId === 'prototype') continue;
      if (typeof sig === 'string' && sig.length > 0 && sig.length <= MAX_SIGNATURE_CHARS) {
        bucket[callId] = sig;
      }
    }
    out[sessionId] = bucket;
  }
  return out;
}

/**
 * Load the store once per directory into its isolated state entry.
 *
 * @param {string} dir - store directory.
 * @returns {{dir: string, db: Record<string, Record<string, string>>, timer: NodeJS.Timeout | undefined}} directory state.
 */
function loadState(dir) {
  const key = keyOf(dir);
  const existing = dirStores.get(key);
  if (existing !== undefined) return existing;
  /** @type {Record<string, Record<string, string>>} */
  let db;
  try {
    const file = fileOf(dir);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_SIGNATURE_FILE_BYTES) {
      db = Object.create(null);
    } else {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      db = migrateSessions(parsed);
    }
  } catch {
    db = Object.create(null);
  }
  const state = { dir, db, timer: undefined };
  dirStores.set(key, state);
  return state;
}

/**
 * Write one directory's signature store to disk and enforce 0o600 permissions.
 *
 * @param {{dir: string, db: Record<string, Record<string, string>>, timer: NodeJS.Timeout | undefined}} state - directory state.
 */
function writeStateToDisk(state) {
  try {
    fs.mkdirSync(state.dir, { recursive: true, mode: 0o700 });
    const target = fileOf(state.dir);
    const payload = JSON.stringify({
      version: SIGNATURE_FORMAT_VERSION,
      sessions: state.db,
    });
    fs.writeFileSync(target, payload, { encoding: 'utf8', mode: 0o600 });
    fs.chmodSync(target, 0o600);
  } catch {
    // Losing a signature only degrades history replay; never fail the call.
  }
}

/**
 * Persist the store for a specific directory, debounced per directory.
 *
 * @param {{dir: string, db: Record<string, Record<string, string>>, timer: NodeJS.Timeout | undefined}} state - directory state.
 */
function scheduleFlush(state) {
  if (state.timer !== undefined) return;
  const run = () => {
    state.timer = undefined;
    writeStateToDisk(state);
  };
  state.timer = setTimeout(run, FLUSH_MS);
  state.timer.unref?.();
}

/**
 * Immediately flush pending signature writes for one directory or all directories.
 *
 * @param {string} [dir] - optional directory to flush; flushes all when omitted.
 */
export function flushSignatures(dir) {
  if (typeof dir === 'string' && dir.length > 0) {
    const state = dirStores.get(keyOf(dir));
    if (state === undefined) return;
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    writeStateToDisk(state);
    return;
  }
  for (const state of dirStores.values()) {
    if (state.timer !== undefined) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
    writeStateToDisk(state);
  }
}

/**
 * Keep the signature of one function call.
 *
 * @param {string} dir - store directory.
 * @param {string} sessionId - owning session, or `default`.
 * @param {string} toolCallId - the tool-call id sent to the harness.
 * @param {string} signature - opaque base64 signature.
 */
export function rememberSignature(dir, sessionId, toolCallId, signature) {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > MAX_SIGNATURE_CHARS) return;
  const state = loadState(dir);
  const key = String(sessionId ?? 'default');
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') return;
  if (toolCallId === '__proto__' || toolCallId === 'constructor' || toolCallId === 'prototype') return;
  const bucket = (state.db[key] ??= Object.create(null));
  bucket[toolCallId] = signature;
  const calls = Object.keys(bucket);
  if (calls.length > MAX_CALLS_PER_SESSION) {
    for (const staleCall of calls.slice(0, calls.length - MAX_CALLS_PER_SESSION)) delete bucket[staleCall];
  }
  const sessions = Object.keys(state.db);
  if (sessions.length > MAX_SESSIONS) {
    for (const stale of sessions.slice(0, sessions.length - MAX_SESSIONS)) delete state.db[stale];
  }
  scheduleFlush(state);
}

/**
 * Recall the signature of one historical function call.
 *
 * @param {string} dir - store directory.
 * @param {string} sessionId - owning session, or `default`.
 * @param {string} toolCallId - the tool-call id sent to the harness.
 * @returns {string | undefined} the signature when known.
 */
export function recallSignature(dir, sessionId, toolCallId) {
  const state = loadState(dir);
  return state.db[String(sessionId ?? 'default')]?.[toolCallId];
}
