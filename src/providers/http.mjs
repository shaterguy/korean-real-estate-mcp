import { ProviderError } from "../common.mjs";

const HOST_ALLOWLIST = new Set([
  "rt.molit.go.kr", "m.land.naver.com", "fin.land.naver.com", "nominatim.openstreetmap.org",
  "overpass-api.de", "overpass.kumi.systems", "overpass.nchc.org.tw",
]);

export class HttpSession {
  constructor({ userAgent = "shaterguy-korean-real-estate-mcp/0.1", timeoutMs = 20000, maxBytes = 8_000_000 } = {}) {
    this.userAgent = userAgent; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes; this.cookies = new Map();
  }
  cookieHeader() { return [...this.cookies.entries()].map(([k,v])=>`${k}=${v}`).join("; "); }
  absorbCookies(headers) {
    const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
    for (const raw of values) { const m = /^([^=;\s]+)=([^;]*)/.exec(raw); if (m) this.cookies.set(m[1], m[2]); }
  }
  async request(url, { method = "GET", headers = {}, body, json, maxBytes = this.maxBytes, timeoutMs = this.timeoutMs, redirect = "follow" } = {}) {
    const u = new URL(url);
    if (!HOST_ALLOWLIST.has(u.hostname)) throw new ProviderError("HOST_NOT_ALLOWED", `Host is not allowed: ${u.hostname}`);
    const h = { "user-agent": this.userAgent, accept: "application/json, text/plain, */*", ...headers };
    const cookie = this.cookieHeader(); if (cookie) h.cookie = cookie;
    let payload = body;
    if (json !== undefined) { payload = JSON.stringify(json); h["content-type"] = "application/json"; }
    const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(), timeoutMs);
    let res;
    try { res = await fetch(u, { method, headers: h, body: payload, redirect, signal: controller.signal }); }
    catch (e) { clearTimeout(timer); throw new ProviderError(e?.name === "AbortError" ? "UPSTREAM_TIMEOUT" : "UPSTREAM_NETWORK", `${u.hostname}: ${e.message}`); }
    clearTimeout(timer); this.absorbCookies(res.headers);
    const len = Number(res.headers.get("content-length") || 0); if (len > maxBytes) throw new ProviderError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
    const ab = await res.arrayBuffer(); if (ab.byteLength > maxBytes) throw new ProviderError("RESPONSE_TOO_LARGE", `Response exceeds ${maxBytes} bytes`);
    const bytes = new Uint8Array(ab);
    return { status: res.status, ok: res.ok, headers: res.headers, bytes, text: new TextDecoder().decode(bytes), url: res.url, location: res.headers.get("location") };
  }
}

export function formBody(obj) { return new URLSearchParams(Object.entries(obj).map(([k,v])=>[k,String(v ?? "")])).toString(); }
