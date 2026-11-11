/**
 * Shared failure type for the Vertex AI adapter.
 *
 * Lives in its own module so transport, auth, projection and the admin routes
 * can throw without importing each other in a cycle. The Harness failure
 * normalizer preserves `code` only for errors that carry it as an own data
 * property, which is why `code` and `failure` are assigned in the constructor.
 */
export class VertexError extends Error {
  /**
   * @param {string} message - operator-facing diagnosis (never contains secrets).
   * @param {string} code - stable machine-routable failure code.
   * @param {Record<string, unknown>} [extra] - extra LlmFailure fields (retry hints).
   */
  constructor(message, code, extra) {
    super(message);
    this.name = 'VertexError';
    this.code = code;
    this.failure = extra === undefined ? { message, code } : { message, code, ...extra };
  }
}
