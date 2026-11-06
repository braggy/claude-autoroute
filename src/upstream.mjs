// HTTP(S) sending with connect / response-header timeouts, and a circuit breaker.
import http from "node:http";
import https from "node:https";

export class NetworkError extends Error {}

export function send({ url, method = "POST", headers, body }, { connectTimeoutMs = 10000, responseTimeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === "http:" ? http : https;
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; clearTimeout(rt); reject(e instanceof NetworkError ? e : new NetworkError(e.message)); } };
    const req = lib.request(u, { method, headers }, (res) => {
      settled = true; clearTimeout(rt); resolve(res);
    });
    const rt = setTimeout(() => { req.destroy(new NetworkError(`no response within ${responseTimeoutMs} ms`)); }, responseTimeoutMs);
    req.on("socket", (s) => {
      if (s.connecting === false) return;
      const ct = setTimeout(() => req.destroy(new NetworkError(`connect timeout after ${connectTimeoutMs} ms`)), connectTimeoutMs);
      s.once("connect", () => clearTimeout(ct));
      s.once("secureConnect", () => clearTimeout(ct));
      s.once("close", () => clearTimeout(ct));
    });
    req.on("error", fail);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

export class TooLargeError extends Error {}

/** Read a whole stream into memory, refusing anything over maxBytes. */
export function readAll(stream, maxBytes = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, done = false;
    stream.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) { done = true; chunks.length = 0; stream.resume(); return reject(new TooLargeError(`body over ${maxBytes} bytes`)); }
      chunks.push(c);
    });
    stream.on("end", () => { if (!done) { done = true; resolve(Buffer.concat(chunks)); } });
    stream.on("error", (e) => { if (!done) { done = true; reject(e); } });
  });
}

// Per-provider circuit breaker. A failed provider is skipped for cooldownSeconds,
// so a chat stays on the backup instead of bouncing (each bounce costs a cache rebuild).
export class Breaker {
  constructor(order, cooldownSeconds, now = () => Date.now()) {
    this.order = order; this.cooldownMs = cooldownSeconds * 1000; this.now = now;
    this.downUntil = new Map(); this.lastError = new Map();
  }
  candidates() {
    const t = this.now();
    const up = this.order.filter((p) => !(this.downUntil.get(p) > t));
    // If everything is down, try them all anyway (in order) rather than failing outright.
    return up.length ? up : [...this.order];
  }
  active() { return this.candidates()[0]; }
  fail(p, why) { this.downUntil.set(p, this.now() + this.cooldownMs); this.lastError.set(p, why); }
  ok(p) { this.downUntil.delete(p); this.lastError.delete(p); }
  status() {
    const t = this.now();
    return this.order.map((p) => ({
      provider: p, up: !(this.downUntil.get(p) > t),
      retryInSeconds: this.downUntil.get(p) > t ? Math.round((this.downUntil.get(p) - t) / 1000) : 0,
      lastError: this.lastError.get(p) || null,
    }));
  }
}
