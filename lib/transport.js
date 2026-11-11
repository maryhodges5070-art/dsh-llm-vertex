/**
 * Minimal HTTP transport with explicit proxy support.
 *
 * Node's global `fetch` (undici) ignores HTTP(S)_PROXY and accepts no
 * per-request dispatcher without importing undici, so proxying would otherwise
 * require TUN mode or a process-wide env switch. This module speaks HTTP/1.1
 * through `node:http` and can tunnel the connection through:
 *
 *   - an HTTP proxy   (`http://[user:pass@]host:port`)  → CONNECT
 *   - an HTTPS proxy  (`https://[user:pass@]host:port`) → TLS + CONNECT
 *   - a SOCKS5 proxy  (`socks5://[user:pass@]host:port`, `socks5h`) → RFC 1928
 *
 * Everything stays on the Node standard library, so the plugin keeps its
 * zero-dependency footprint.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { VertexError } from './errors.js';

const DEFAULT_PROXY_PORTS = { http: 8080, https: 443, socks5: 1080 };
const SUPPORTED_PROXY_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:']);

/**
 * Parse and validate a proxy URL.
 *
 * @param {unknown} raw - configured proxy URL (empty means "direct").
 * @returns {null | {kind: 'http' | 'https' | 'socks5', hostname: string, port: number,
 *   username?: string, password?: string}} proxy descriptor, or null for direct.
 */
export function parseProxyUrl(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') {
    throw new VertexError('代理地址必须是字符串。', 'INVALID_PROXY');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new VertexError(`代理地址不是合法的 URL：${trimmed.slice(0, 80)}`, 'INVALID_PROXY');
  }
  if (!SUPPORTED_PROXY_SCHEMES.has(parsed.protocol)) {
    throw new VertexError(
      `不支持的代理协议 ${parsed.protocol}；请使用 http://、https://、socks5:// 或 socks5h://。`,
      'INVALID_PROXY',
    );
  }
  const kind = parsed.protocol.startsWith('socks5') ? 'socks5' : parsed.protocol === 'https:' ? 'https' : 'http';
  const hostname = parsed.hostname;
  if (hostname.length === 0) {
    throw new VertexError('代理地址缺少主机名。', 'INVALID_PROXY');
  }
  const port = parsed.port === '' ? DEFAULT_PROXY_PORTS[kind] : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new VertexError('代理端口无效。', 'INVALID_PROXY');
  }
  const username = parsed.username === '' ? undefined : decodeURIComponent(parsed.username);
  const password = parsed.password === '' ? undefined : decodeURIComponent(parsed.password);
  return {
    kind,
    hostname,
    port,
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
  };
}

/**
 * Describe a proxy without echoing credentials (for state routes and logs).
 *
 * @param {unknown} raw - configured proxy URL.
 * @returns {string} `kind://host:port` with an auth marker, or '' for direct.
 */
export function describeProxy(raw) {
  const proxy = parseProxyUrl(raw);
  if (proxy === null) return '';
  const auth = proxy.username === undefined ? '' : ' (auth)';
  return `${proxy.kind}://${proxy.hostname}:${proxy.port}${auth}`;
}

/**
 * Open a TCP connection to the proxy with connect timeout and abort support.
 *
 * @param {string} host - proxy host.
 * @param {number} port - proxy port.
 * @param {{timeoutMs: number, signal?: AbortSignal, label: string}} options - limits.
 * @returns {Promise<net.Socket>} a connected socket.
 */
function connectTcp(host, port, options) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      options.signal?.removeEventListener?.('abort', onAbort);
      if (error !== undefined) {
        socket.destroy();
        reject(error);
      } else {
        socket.setNoDelay(true);
        resolve(socket);
      }
    };
    const timer = setTimeout(() => {
      finish(new VertexError(`连接${options.label}超时（${options.timeoutMs}ms）。`, 'PROXY_TIMEOUT'));
    }, options.timeoutMs);
    const onConnect = () => finish(undefined);
    const onError = (error) => {
      finish(new VertexError(
        `无法连接${options.label} ${host}:${port}：${error instanceof Error ? error.message : String(error)}`,
        'PROXY_CONNECT_FAILED',
      ));
    };
    const onAbort = () => finish(options.signal?.reason ?? new VertexError('请求已取消。', 'ABORTED'));
    socket.once('connect', onConnect);
    socket.once('error', onError);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/** Push leftover bytes back so sequential readers do not lose data. */
class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiter = null;
    this.closed = false;
    this.error = undefined;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.flush();
    };
    this.onError = (error) => {
      this.error = error;
      this.flush();
    };
    this.onEnd = () => {
      this.closed = true;
      this.flush();
    };
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onEnd);
  }

  flush() {
    const waiter = this.waiter;
    if (waiter === null) return;
    this.waiter = null;
    waiter();
  }

  detach() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('close', this.onEnd);
    const rest = this.buffer;
    this.buffer = Buffer.alloc(0);
    if (rest.length > 0) this.socket.unshift(rest);
  }

  /**
   * Read exactly `size` bytes.
   *
   * @param {number} size - byte count.
   * @returns {Promise<Buffer>} the bytes.
   */
  async read(size) {
    while (this.buffer.length < size) {
      if (this.error !== undefined) throw this.error;
      if (this.closed) throw new VertexError('代理连接在协商过程中关闭。', 'PROXY_TUNNEL_FAILED');
      await new Promise((resolve) => {
        this.waiter = resolve;
      });
    }
    const out = this.buffer.subarray(0, size);
    this.buffer = this.buffer.subarray(size);
    return out;
  }

  /**
   * Read until the delimiter appears (returns bytes before it, discards it).
   *
   * @param {string} delimiter - ASCII delimiter.
   * @param {number} limit - safety cap on the header block size.
   * @returns {Promise<string>} the bytes before the delimiter as latin1 text.
   */
  async readUntil(delimiter, limit = 16 * 1024) {
    for (;;) {
      const index = this.buffer.indexOf(delimiter);
      if (index !== -1) {
        const head = this.buffer.subarray(0, index);
        this.buffer = this.buffer.subarray(index + delimiter.length);
        return head.toString('latin1');
      }
      if (this.buffer.length > limit) {
        throw new VertexError('代理响应头过大，已中止。', 'PROXY_TUNNEL_FAILED');
      }
      if (this.error !== undefined) throw this.error;
      if (this.closed) throw new VertexError('代理连接在协商过程中关闭。', 'PROXY_TUNNEL_FAILED');
      await new Promise((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}

/**
 * Wrap a connected socket in TLS.
 *
 * @param {net.Socket} socket - underlying TCP socket.
 * @param {string} serverName - SNI host.
 * @param {{timeoutMs: number, signal?: AbortSignal}} options - limits.
 * @returns {Promise<tls.TLSSocket>} the TLS socket.
 */
function wrapTls(socket, serverName, options) {
  return new Promise((resolve, reject) => {
    const tlsOptions = { socket, ALPNProtocols: ['http/1.1'] };
    if (!net.isIP(serverName)) tlsOptions.servername = serverName;
    const secure = tls.connect(tlsOptions);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      secure.removeListener('secureConnect', onSecure);
      secure.removeListener('error', onError);
      options.signal?.removeEventListener?.('abort', onAbort);
      if (error !== undefined) {
        secure.destroy();
        reject(error);
      } else {
        resolve(secure);
      }
    };
    const timer = setTimeout(() => {
      finish(new VertexError(`代理隧道 TLS 握手超时（${options.timeoutMs}ms）。`, 'PROXY_TIMEOUT'));
    }, options.timeoutMs);
    const onSecure = () => finish(undefined);
    const onError = (error) => {
      finish(new VertexError(
        `代理隧道 TLS 握手失败：${error instanceof Error ? error.message : String(error)}`,
        'PROXY_TUNNEL_FAILED',
      ));
    };
    const onAbort = () => finish(options.signal?.reason ?? new VertexError('请求已取消。', 'ABORTED'));
    secure.once('secureConnect', onSecure);
    secure.once('error', onError);
    options.signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

/**
 * Establish a tunnel to `targetHost:targetPort` through an HTTP(S) proxy.
 *
 * @param {{kind: string, hostname: string, port: number, username?: string, password?: string}} proxy - proxy descriptor.
 * @param {string} targetHost - target host.
 * @param {number} targetPort - target port.
 * @param {{timeoutMs: number, signal?: AbortSignal}} options - limits.
 * @returns {Promise<net.Socket>} a socket already connected to the target.
 */
async function httpTunnel(proxy, targetHost, targetPort, options) {
  let socket = await connectTcp(proxy.hostname, proxy.port, { ...options, label: ' HTTP 代理' });
  if (proxy.kind === 'https') {
    try {
      socket = await wrapTls(socket, proxy.hostname, options);
    } catch (error) {
      // A plain-HTTP proxy addressed through an https:// URL is a common
      // misconfiguration; retry the CONNECT in plaintext instead of failing.
      options.warn?.(`代理 TLS 握手失败（${error instanceof Error ? error.message : String(error)}），已改用明文 CONNECT。`);
      socket = await connectTcp(proxy.hostname, proxy.port, { ...options, label: ' HTTP 代理' });
    }
  }
  const authority = `${targetHost}:${targetPort}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.username !== undefined) {
    const credential = `${proxy.username}:${proxy.password ?? ''}`;
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(credential, 'utf8').toString('base64')}`);
  }
  socket.write(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  const reader = new SocketReader(socket);
  try {
    const head = await reader.readUntil('\r\n\r\n');
    const statusLine = head.split('\r\n', 1)[0] ?? '';
    const status = Number(statusLine.split(' ')[1]);
    if (status === 407) {
      throw new VertexError('代理要求认证（HTTP 407）；请在代理地址里带上用户名和密码。', 'PROXY_AUTH_REQUIRED');
    }
    if (status !== 200) {
      throw new VertexError(`代理拒绝了 CONNECT ${authority}（HTTP ${Number.isFinite(status) ? status : '未知'}）。`, 'PROXY_TUNNEL_FAILED');
    }
  } finally {
    reader.detach();
  }
  return socket;
}

/**
 * Establish a tunnel through a SOCKS5 proxy (RFC 1928, optional user/pass auth).
 *
 * @param {{hostname: string, port: number, username?: string, password?: string}} proxy - proxy descriptor.
 * @param {string} targetHost - target host.
 * @param {number} targetPort - target port.
 * @param {{timeoutMs: number, signal?: AbortSignal}} options - limits.
 * @returns {Promise<net.Socket>} a socket already connected to the target.
 */
async function socks5Tunnel(proxy, targetHost, targetPort, options) {
  const socket = await connectTcp(proxy.hostname, proxy.port, { ...options, label: ' SOCKS5 代理' });
  const reader = new SocketReader(socket);
  try {
    const methods = proxy.username === undefined ? [0x00] : [0x00, 0x02];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));
    const greeting = await reader.read(2);
    if (greeting[0] !== 0x05) {
      throw new VertexError('SOCKS5 代理返回了不支持的协议版本。', 'PROXY_TUNNEL_FAILED');
    }
    if (greeting[1] === 0x02) {
      const user = Buffer.from(proxy.username ?? '', 'utf8');
      const pass = Buffer.from(proxy.password ?? '', 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]));
      const authReply = await reader.read(2);
      if (authReply[1] !== 0x00) {
        throw new VertexError('SOCKS5 代理认证失败（用户名或密码不正确）。', 'PROXY_AUTH_REQUIRED');
      }
    } else if (greeting[1] !== 0x00) {
      throw new VertexError('SOCKS5 代理要求不支持的认证方式。', 'PROXY_AUTH_REQUIRED');
    }
    const host = Buffer.from(targetHost, 'utf8');
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]),
      host,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ]);
    socket.write(request);
    const reply = await reader.read(4);
    if (reply[0] !== 0x05) {
      throw new VertexError('SOCKS5 代理返回了无效应答。', 'PROXY_TUNNEL_FAILED');
    }
    if (reply[1] !== 0x00) {
      throw new VertexError(`SOCKS5 代理拒绝连接（错误码 ${reply[1]}）。`, 'PROXY_TUNNEL_FAILED');
    }
    if (reply[3] === 0x01) await reader.read(4);
    else if (reply[3] === 0x03) {
      const length = (await reader.read(1))[0];
      await reader.read(length);
    } else await reader.read(16);
    await reader.read(2);
  } finally {
    reader.detach();
  }
  return socket;
}

/**
 * Convert a Node readable into a web ReadableStream of Uint8Array chunks.
 *
 * @param {import('node:stream').Readable} nodeStream - response stream.
 * @param {() => void} [onDone] - called once when the stream ends or errors.
 * @returns {ReadableStream<Uint8Array>} web stream.
 */
function toWebStream(nodeStream, onDone) {
  let finished = false;
  const once = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => {
        if (finished) return;
        controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
      });
      nodeStream.on('end', () => {
        once();
        controller.close();
      });
      nodeStream.on('error', (error) => {
        once();
        controller.error(error);
      });
    },
    cancel(reason) {
      once();
      nodeStream.destroy(reason instanceof Error ? reason : undefined);
    },
  });
}

/**
 * Web-Stream-like body backed by an already-buffered string.
 *
 * @param {string} text - buffered body.
 * @returns {ReadableStream<Uint8Array>} stream over the buffered bytes.
 */
function textStream(text) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Read a Node readable fully into a string.
 *
 * @param {import('node:stream').Readable} nodeStream - stream to drain.
 * @returns {Promise<string>} decoded body.
 */
function readAll(nodeStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    nodeStream.on('data', (chunk) => chunks.push(chunk));
    nodeStream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    nodeStream.on('error', reject);
  });
}

/**
 * Build a Response-like object from a finished Node request.
 *
 * Non-2xx bodies are buffered so callers can read the error text repeatedly
 * (retry hints) without racing the live stream.
 *
 * @param {import('node:http').IncomingMessage} response - Node response.
 * @param {string | undefined} buffered - pre-read body, when buffering.
 * @returns {object} Response-like adapter.
 */
function makeResponse(response, buffered) {
  const status = response.statusCode ?? 0;
  const headers = {
    get(name) {
      const value = response.headers[String(name).toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? value.join(', ') : String(value);
    },
  };
  const body = buffered !== undefined ? textStream(buffered) : toWebStream(response);
  return {
    status,
    statusText: response.statusMessage ?? '',
    ok: status >= 200 && status < 300,
    headers,
    body,
    async text() {
      if (buffered !== undefined) return buffered;
      return await readAll(response);
    },
    clone() {
      return makeResponse(response, buffered);
    },
  };
}

/**
 * Perform an HTTP(S) request, optionally through an explicit proxy.
 *
 * @param {string} urlString - absolute URL.
 * @param {{
 *   method?: string,
 *   headers?: Record<string, string>,
 *   body?: string,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 *   proxyUrl?: string,
 * }} [options] - request options; `proxyUrl` empty means a direct connection.
 * @returns {Promise<object>} Response-like adapter with a web-stream body.
 */
export async function request(urlString, options = {}) {
  const url = new URL(urlString);
  const isHttps = url.protocol === 'https:';
  if (!isHttps && url.protocol !== 'http:') {
    throw new VertexError(`不支持的 URL 协议：${url.protocol}`, 'INVALID_REQUEST');
  }
  const method = options.method ?? 'GET';
  const headers = { ...(options.headers ?? {}) };
  const timeoutMs = options.timeoutMs ?? 120_000;
  const signal = options.signal;
  const proxy = parseProxyUrl(options.proxyUrl);
  const port = url.port === '' ? (isHttps ? 443 : 80) : Number(url.port);
  const path = `${url.pathname}${url.search}`;

  if (options.body !== undefined && headers['content-length'] === undefined) {
    headers['content-length'] = String(Buffer.byteLength(options.body, 'utf8'));
  }
  if (headers.host === undefined) headers.host = url.host;
  headers.connection = 'close';

  const start = (agent) => new Promise((resolve, reject) => {
    const requestOptions = {
      host: url.hostname,
      port,
      path,
      method,
      headers,
      signal,
      ...(agent !== undefined ? { agent } : {}),
    };
    const client = isHttps && agent === undefined ? https : http;
    const req = client.request(requestOptions);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) {
        req.destroy();
        reject(error);
      } else {
        resolve({ req, response: value });
      }
    };
    const timer = setTimeout(() => {
      finish(new VertexError(`请求上游超时（${timeoutMs}ms 内未完成响应头）。`, 'TIMEOUT'));
    }, timeoutMs);
    req.on('response', (response) => finish(undefined, response));
    req.on('error', (error) => {
      if (signal?.aborted === true) {
        finish(signal.reason instanceof Error ? signal.reason : new VertexError('请求已取消。', 'ABORTED'));
        return;
      }
      finish(new VertexError(`网络请求失败：${error instanceof Error ? error.message : String(error)}`, 'NETWORK_ERROR'));
    });
    if (options.body !== undefined) req.write(options.body, 'utf8');
    req.end();
  });

  let req;
  let response;
  if (proxy === null) {
    ({ req, response } = await start(undefined));
  } else {
    let socket = proxy.kind === 'socks5'
      ? await socks5Tunnel(proxy, url.hostname, port, { timeoutMs, signal })
      : await httpTunnel(proxy, url.hostname, port, { timeoutMs, signal, warn: options.warn });
    if (isHttps) socket = await wrapTls(socket, url.hostname, { timeoutMs, signal });
    const agent = new http.Agent({ keepAlive: false });
    agent.createConnection = (_options, callback) => callback(null, socket);
    ({ req, response } = await start(agent));
  }

  // Buffer error bodies (429/503 retry hints need to be read more than once).
  const nonOk = (response.statusCode ?? 0) >= 400;
  if (nonOk) {
    const text = await readAll(response).catch(() => '');
    req.destroy();
    return makeResponse(response, text);
  }
  return makeResponse(response, undefined);
}
