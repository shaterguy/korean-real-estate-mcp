import { ProviderError } from "../common.mjs";
import { getRequestSignal } from "../request-context.mjs";

export const HOST_ALLOWLIST = new Set([
  "rt.molit.go.kr", "m.land.naver.com", "fin.land.naver.com", "nominatim.openstreetmap.org",
  "overpass-api.de", "overpass.kumi.systems", "overpass.nchc.org.tw",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const PROVIDER_LIMITS = Object.freeze({ rtms: 3, naver: 3, nominatim: 1, overpass: 2 });
const providerStates = new Map(Object.entries(PROVIDER_LIMITS).map(([key, max]) => [
  key, { active: 0, max, queue: [], nextAt: 0, spacingMs: key === "nominatim" ? 1050 : 0 },
]));
function providerFamily(hostname) {
  if (hostname === "rt.molit.go.kr") return "rtms";
  if (hostname === "m.land.naver.com" || hostname === "fin.land.naver.com") return "naver";
  if (hostname === "nominatim.openstreetmap.org") return "nominatim";
  return "overpass";
}
function cancelledError() {
  return new ProviderError("REQUEST_CANCELLED", "Caller disconnected or aborted");
}
function releaseProviderSlot(state) {
  const next = state.queue.shift();
  if (next) {
    next.signal.removeEventListener("abort", next.onAbort);
    next.resolve();
  } else {
    state.active -= 1;
  }
}
async function waitPacing(milliseconds, signal) {
  if (!milliseconds) return;
  await new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(cancelledError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
async function acquireProviderSlot(hostname, signal) {
  const state = providerStates.get(providerFamily(hostname));
  if (signal.aborted) throw cancelledError();
  if (state.active < state.max) {
    state.active += 1;
  } else {
    if (state.queue.length >= 24) throw new ProviderError("PROVIDER_BUSY", hostname + ": provider queue full");
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, onAbort: null };
      entry.onAbort = () => {
        const index = state.queue.indexOf(entry);
        if (index >= 0) { state.queue.splice(index, 1); reject(cancelledError()); }
      };
      state.queue.push(entry);
      signal.addEventListener("abort", entry.onAbort, { once: true });
      if (signal.aborted) entry.onAbort();
    });
  }
  const release = () => releaseProviderSlot(state);
  try {
    if (state.spacingMs) {
      const now = Date.now();
      const startAt = Math.max(now, state.nextAt);
      state.nextAt = startAt + state.spacingMs;
      await waitPacing(startAt - now, signal);
    }
    if (signal.aborted) throw cancelledError();
    return release;
  } catch (e) {
    release();
    throw e;
  }
}

const HOST_BOUND_HEADERS = new Set(["cookie", "authorization", "proxy-authorization"]);

function deleteHeader(headers, name) {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) if (key.toLowerCase() === target) delete headers[key];
}
function stripHostBoundHeaders(headers) {
  for (const key of Object.keys(headers)) if (HOST_BOUND_HEADERS.has(key.toLowerCase())) delete headers[key];
}
function headerValue(headers, name) {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === target) return String(value);
  return "";
}
function cancelBody(body) {
  try {
    const pending = body?.cancel?.();
    if (pending?.catch) pending.catch(() => {});
  } catch {}
}
function timeoutError(hostname) {
  return new ProviderError("UPSTREAM_TIMEOUT", `${hostname}: request timed out`);
}
function cancellationError(hostname, timerSignal) {
  return timerSignal.aborted ? timeoutError(hostname) : new ProviderError("REQUEST_CANCELLED", hostname + ": caller disconnected");
}
async function readChunk(reader, signal, hostname, timerSignal) {
  if (signal.aborted) throw cancellationError(hostname, timerSignal);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(cancellationError(hostname, timerSignal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
async function readBoundedBody(res, { maxBytes, signal, hostname, timerSignal }) {
  const rawLength = res.headers.get("content-length");
  const declaredLength = rawLength === null ? null : Number(rawLength);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    cancelBody(res.body);
    throw new ProviderError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return new Uint8Array();

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await readChunk(reader, signal, hostname, timerSignal);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try {
          const pending = reader.cancel("response too large");
          if (pending?.catch) pending.catch(() => {});
        } catch {}
        throw new ProviderError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } catch (e) {
    try {
      const pending = reader.cancel(e);
      if (pending?.catch) pending.catch(() => {});
    } catch {}
    if (e?.code === "UPSTREAM_TIMEOUT" || e?.code === "RESPONSE_TOO_LARGE" || e?.code === "REQUEST_CANCELLED") throw e;
    if (signal.aborted || e?.name === "AbortError") throw cancellationError(hostname, timerSignal);
    throw new ProviderError("UPSTREAM_NETWORK", `${hostname}: ${e?.message || "response body read failed"}`);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  if (signal.aborted) throw cancellationError(hostname, timerSignal);

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function validateExternalUrl(value) {
  let u;
  try { u = value instanceof URL ? new URL(value.href) : new URL(value); }
  catch { throw new ProviderError("INVALID_URL", "Invalid upstream URL"); }
  if (u.protocol !== "https:") throw new ProviderError("SCHEME_NOT_ALLOWED", `Only HTTPS upstreams are allowed: ${u.protocol}`);
  if (u.username || u.password) throw new ProviderError("URL_CREDENTIALS_NOT_ALLOWED", "Credentials in upstream URLs are not allowed");
  if (!HOST_ALLOWLIST.has(u.hostname)) throw new ProviderError("HOST_NOT_ALLOWED", `Host is not allowed: ${u.hostname}`);
  return u;
}

export class HttpSession {
  constructor({ userAgent = "shaterguy-korean-real-estate-mcp/0.1", timeoutMs = 20000, maxBytes = 8_000_000, maxRedirects = 3, fetchImpl = globalThis.fetch } = {}) {
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.maxRedirects = maxRedirects;
    this.fetchImpl = fetchImpl;
    this.cookies = new Map();
  }
  cookieHeader(url) {
    const jar = this.cookies.get(url.origin);
    return jar ? [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ") : "";
  }
  absorbCookies(url, headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
    if (!values.length) return;
    let jar = this.cookies.get(url.origin);
    if (!jar) {
      jar = new Map();
      this.cookies.set(url.origin, jar);
    }
    for (const raw of values) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(raw);
      if (m) jar.set(m[1], m[2]);
    }
  }
  async request(url, { method = "GET", headers = {}, body, json, maxBytes = this.maxBytes, timeoutMs = this.timeoutMs, redirect = "follow", maxRedirects = this.maxRedirects } = {}) {
    if (!new Set(["follow", "manual", "error"]).has(redirect)) throw new ProviderError("INVALID_REDIRECT_MODE", `Unsupported redirect mode: ${redirect}`);
    let current = validateExternalUrl(url);
    let currentMethod = String(method).toUpperCase();
    let currentBody = body;
    const baseHeaders = { "user-agent": this.userAgent, accept: "application/json, text/plain, */*", ...headers };
    if (json !== undefined) {
      currentBody = JSON.stringify(json);
      baseHeaders["content-type"] = "application/json";
    }

    const deadline = Date.now() + timeoutMs;
    const controller = new AbortController();
    const callerSignal = getRequestSignal();
    const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    try {
      for (let hop = 0; ; hop += 1) {
        if (deadline - Date.now() <= 0) throw timeoutError(current.hostname);
        if (signal.aborted) throw cancellationError(current.hostname, controller.signal);

        const requestHeaders = { ...baseHeaders };
        const explicitCookie = headerValue(requestHeaders, "cookie");
        deleteHeader(requestHeaders, "cookie");
        const scopedCookie = this.cookieHeader(current);
        const cookie = [explicitCookie, scopedCookie].filter(Boolean).join("; ");
        if (cookie) requestHeaders.cookie = cookie;

        let releaseSlot;
        try {
          releaseSlot = await acquireProviderSlot(current.hostname, signal);
        } catch (e) {
          if (controller.signal.aborted) throw timeoutError(current.hostname);
          throw e;
        }
        try {
          let res;
          try {
            res = await this.fetchImpl(current, { method: currentMethod, headers: requestHeaders, body: currentBody, redirect: "manual", signal });
          } catch (e) {
            if (signal.aborted || e?.name === "AbortError") throw cancellationError(current.hostname, controller.signal);
            throw new ProviderError("UPSTREAM_NETWORK", `${current.hostname}: ${e?.message || "network error"}`);
          }

          this.absorbCookies(current, res.headers);
          const isRedirect = REDIRECT_STATUSES.has(res.status);
          if (isRedirect && redirect === "error") {
            cancelBody(res.body);
            throw new ProviderError("UPSTREAM_REDIRECT", `${current.hostname}: unexpected HTTP ${res.status}`);
          }
          if (isRedirect && redirect === "follow") {
            if (hop >= maxRedirects) {
              cancelBody(res.body);
              throw new ProviderError("TOO_MANY_REDIRECTS", `${current.hostname}: more than ${maxRedirects} redirects`);
            }
            const location = res.headers.get("location");
            if (!location) {
              cancelBody(res.body);
              throw new ProviderError("UPSTREAM_REDIRECT", `${current.hostname}: redirect missing Location header`);
            }
            const target = new URL(location, current);
            cancelBody(res.body);
            const next = validateExternalUrl(target);
            if ((res.status === 307 || res.status === 308) && currentMethod !== "GET" && currentMethod !== "HEAD" && next.origin !== current.origin) {
              throw new ProviderError("CROSS_ORIGIN_BODY_REDIRECT", "Redirect may not forward a request body to another origin");
            }
            if (next.origin !== current.origin) stripHostBoundHeaders(baseHeaders);
            if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
              currentMethod = "GET";
              currentBody = undefined;
              deleteHeader(baseHeaders, "content-type");
              deleteHeader(baseHeaders, "content-length");
            }
            current = next;
            continue;
          }

          if (res.url) {
            try { validateExternalUrl(res.url); }
            catch (e) { cancelBody(res.body); throw e; }
          }
          const bytes = await readBoundedBody(res, { maxBytes, signal, hostname: current.hostname, timerSignal: controller.signal });
          if (signal.aborted) throw cancellationError(current.hostname, controller.signal);
          return { status: res.status, ok: res.ok, headers: res.headers, bytes, text: new TextDecoder().decode(bytes), url: res.url || current.href, location: res.headers.get("location") };
        } finally {
          releaseSlot();
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}

export function formBody(obj) { return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v ?? "")])).toString(); }
