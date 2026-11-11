/**
 * Outbound rate limiting for the Vertex adapter.
 *
 * Two independent ceilings are enforced in-process, before any request leaves
 * the machine: a sliding one-minute window on request starts, and a cap on how
 * many requests may be in flight at once. Waiting is FIFO and abortable, so a
 * cancelled turn does not hold a slot.
 */

import { VertexError } from './errors.js';

const MINUTE_MS = 60_000;
const DEFAULTS = { requestsPerMinute: 60, maxConcurrent: 4, acquireTimeoutMs: 30_000 };

/** @type {{rpm: number, maxConcurrent: number, acquireTimeoutMs: number, active: number, starts: number[], queue: any[], timer: any}} */
const state = {
  rpm: DEFAULTS.requestsPerMinute,
  maxConcurrent: DEFAULTS.maxConcurrent,
  acquireTimeoutMs: DEFAULTS.acquireTimeoutMs,
  active: 0,
  starts: [],
  queue: [],
  timer: undefined,
};

/**
 * Apply the configured ceilings to subsequent acquisitions.
 *
 * @param {any} config - normalized plugin configuration.
 * @returns {void}
 */
export function configureLimit(config) {
  state.rpm = positive(config?.requestsPerMinute, DEFAULTS.requestsPerMinute);
  state.maxConcurrent = positive(config?.maxConcurrent, DEFAULTS.maxConcurrent);
  state.acquireTimeoutMs = positive(config?.acquireTimeoutMs, DEFAULTS.acquireTimeoutMs);
}

/**
 * How much of the allowance is currently spent.
 *
 * @returns {{requestsPerMinute: number, maxConcurrent: number, active: number, usedThisMinute: number, queued: number}} snapshot.
 */
export function limitStatus() {
  prune(Date.now());
  return {
    requestsPerMinute: state.rpm,
    maxConcurrent: state.maxConcurrent,
    active: state.active,
    usedThisMinute: state.starts.length,
    queued: state.queue.length,
  };
}

/**
 * Wait for a slot, then run the request and release it afterwards.
 *
 * @param {any} config - normalized plugin configuration.
 * @param {AbortSignal | undefined} signal - the caller's cancellation signal.
 * @returns {Promise<() => void>} call exactly once to return the slot.
 */
export async function acquireLimit(config, signal) {
  configureLimit(config);
  const release = await new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: undefined, settled: false, timer: undefined };
    waiter.cleanup = () => {
      if (waiter.onAbort !== undefined) signal?.removeEventListener?.('abort', waiter.onAbort);
      waiter.onAbort = undefined;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.timer = undefined;
    };
    if (signal?.aborted === true) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    waiter.onAbort = () => {
      if (waiter.settled) return;
      waiter.settled = true;
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      waiter.cleanup();
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener?.('abort', waiter.onAbort, { once: true });
    // A full queue must fail loudly: an unanswered slot request would leave the
    // turn hanging with no output and no error, which looks like a stalled model.
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return;
      waiter.settled = true;
      const index = state.queue.indexOf(waiter);
      if (index >= 0) state.queue.splice(index, 1);
      waiter.cleanup();
      reject(new VertexError(
        `Vertex AI request waited ${state.acquireTimeoutMs}ms for a free slot `
        + `(${state.active} in flight, ${state.queue.length} queued, maxConcurrent=${state.maxConcurrent}); `
        + 'a previous stream may have leaked its slot. Raise maxConcurrent in 设置 → Vertex AI, or retry.',
        'CONCURRENCY_TIMEOUT',
      ));
    }, state.acquireTimeoutMs);
    if (typeof waiter.timer.unref === 'function') waiter.timer.unref();
    state.queue.push(waiter);
    pump();
  });
  return release;
}

/**
 * Whether a grant is possible right now without queueing.
 *
 * @param {number} now - current epoch milliseconds.
 * @returns {boolean} true when both ceilings have room.
 */
function available(now) {
  prune(now);
  return state.active < state.maxConcurrent && state.starts.length < state.rpm;
}

/**
 * Grant as many queued waiters as the ceilings allow.
 *
 * @returns {void}
 */
function pump() {
  const now = Date.now();
  prune(now);
  while (state.queue.length > 0 && available(now)) {
    const waiter = state.queue.shift();
    if (waiter.settled) continue;
    waiter.settled = true;
    waiter.cleanup();
    state.starts.push(now);
    state.active += 1;
    waiter.resolve(releaseSlot);
  }
  if (state.queue.length > 0 && state.timer === undefined) {
    const wait = state.starts.length >= state.rpm && state.starts.length > 0
      ? state.starts[0] + MINUTE_MS - now
      : 25;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      pump();
    }, Math.max(wait, 0));
    if (typeof state.timer.unref === 'function') state.timer.unref();
  }
}

/**
 * Return one in-flight slot and let the next waiter through.
 *
 * @returns {void}
 */
function releaseSlot() {
  state.active = Math.max(0, state.active - 1);
  pump();
}

/**
 * Drop request starts that fell out of the one-minute window.
 *
 * @param {number} now - current epoch milliseconds.
 * @returns {void}
 */
function prune(now) {
  while (state.starts.length > 0 && now - state.starts[0] >= MINUTE_MS) state.starts.shift();
}

/**
 * Coerce a configured ceiling to a positive integer.
 *
 * @param {unknown} value - candidate value.
 * @param {number} fallback - value used when the candidate is unusable.
 * @returns {number} a positive integer.
 */
function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.floor(number) : fallback;
}
