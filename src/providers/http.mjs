import { ProviderError } from "../common.mjs";

export const HOST_ALLOWLIST = new Set([
  "rt.molit.go.kr", "m.land.naver.com", "fin.land.naver.com", "nominatim.openstreetmap.org",
  "overpass-api.de", "overpass.kumi.systems", "overpass.nchc.org.tw",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  cookieHeader() { return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; "); }
  absorbCookies(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
    for (const raw of values) {
      const m = /^([^=;\s]+)=([^;]*)/.exec(raw);
      if (m) this.cookies.set(m[1], m[2]);
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

    for (let hop = 0; ; hop += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new ProviderError("UPSTREAM_TIMEOUT", `${current.hostname}: request timed out`);
      const requestHeaders = { ...baseHeaders };
      const cookie = this.cookieHeader();
      if (cookie) requestHeaders.cookie = cookie;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let res;
      try {
        res = await this.fetchImpl(current, { method: currentMethod, headers: requestHeaders, body: currentBody, redirect: "manual", signal: controller.signal });
      } catch (e) {
        clearTimeout(timer);
        throw new ProviderError(e?.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK", `${current.hostname}: ${e?.message || "network error"}`);
      }
      clearTimeout(timer);
      this.absorbCookies(res.headers);

      const isRedirect = REDIRECT_STATUSES.has(res.status);
      if (isRedirect && redirect === "error") throw new ProviderError("UPSTREAM_REDIRECT", `${current.hostname}: unexpected HTTP ${res.status}`);
      if (isRedirect && redirect === "follow") {
        if (hop >= maxRedirects) throw new ProviderError("TOO_MANY_REDIRECTS", `${current.hostname}: more than ${maxRedirects} redirects`);
        const location = res.headers.get("location");
        if (!location) throw new ProviderError("UPSTREAM_REDIRECT", `${current.hostname}: redirect missing Location header`);
        const next = validateExternalUrl(new URL(location, current));
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && currentMethod === "POST")) {
          currentMethod = "GET";
          currentBody = undefined;
          delete baseHeaders["content-type"];
          delete baseHeaders["content-length"];
        }
        current = next;
        continue;
      }

      if (res.url) validateExternalUrl(res.url);
      const len = Number(res.headers.get("content-length") || 0);
      if (len > maxBytes) throw new ProviderError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
      const ab = await res.arrayBuffer();
      if (ab.byteLength > maxBytes) throw new ProviderError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
      const bytes = new Uint8Array(ab);
      return { status: res.status, ok: res.ok, headers: res.headers, bytes, text: new TextDecoder().decode(bytes), url: res.url || current.href, location: res.headers.get("location") };
    }
  }
}

export function formBody(obj) { return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v ?? "")])).toString(); }
