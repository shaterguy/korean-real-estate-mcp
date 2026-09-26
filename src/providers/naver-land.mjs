import { HttpSession } from "./http.mjs";
import { ProviderError, normalizeName, stripTags, sleep } from "../common.mjs";

const BASE = "https://m.land.naver.com";
const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36";
const NAVER_DETAIL_URL = "https://fin.land.naver.com/front-api/v1/complex/article/list";
const RETRYABLE_ERROR_CODES = new Set(["UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK"]);
const DETAIL_DEGRADE_CODES = new Set(["NAVER_RATE_LIMITED", "NAVER_HTTP", "NAVER_BAD_RESPONSE", "NAVER_DETAIL_CONTRACT_UNVERIFIED", "NAVER_BUSY", "UPSTREAM_TIMEOUT", "UPSTREAM_NETWORK"]);
const UPSTREAM_TEXT_MAX = 512;

function ajaxHeaders() { return { referer: `${BASE}/`, "x-requested-with": "XMLHttpRequest", accept: "application/json, text/javascript, */*; q=0.01" }; }
function parseJson(r, label) { try { return JSON.parse(r.text); } catch { throw new ProviderError("NAVER_BAD_RESPONSE", `${label} was not JSON`, { sourceApi: r.url }); } }
function ensureOk(r, label) {
  if (r.status === 429) throw new ProviderError("NAVER_RATE_LIMITED", `${label} rate limited`, { retry_after_sec: 300, sourceApi: r.url, status: r.status });
  if (!r.ok) throw new ProviderError("NAVER_HTTP", `${label} HTTP ${r.status}`, { sourceApi: r.url, status: r.status });
}
function retryableStatus(status) { return status === 429 || (Number.isInteger(status) && status >= 500 && status <= 599); }
function retryableError(error) { return RETRYABLE_ERROR_CODES.has(error?.code); }

export class NaverRequestController {
  constructor({ maxConcurrency = 3, maxQueue = 32, maxAttempts = 3, baseDelayMs = 250, maxDelayMs = 1200, jitterMs = 125, maxCacheEntries = 128, sleepFn = sleep, randomFn = Math.random } = {}) {
    this.maxConcurrency = maxConcurrency;
    this.maxQueue = maxQueue;
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.jitterMs = jitterMs;
    this.maxCacheEntries = maxCacheEntries;
    this.sleepFn = sleepFn;
    this.randomFn = randomFn;
    this.active = 0;
    this.queue = [];
    this.cache = new Map();
    this.inFlight = new Map();
  }
  _getCache(key) {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) { this.cache.delete(key); return undefined; }
    return entry.value;
  }
  _setCache(key, value, ttlMs) {
    if (!ttlMs || value?.ok !== true) return;
    if (!this.cache.has(key) && this.cache.size >= this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
  async _acquire() {
    if (this.active < this.maxConcurrency) { this.active += 1; return; }
    if (this.queue.length >= this.maxQueue) throw new ProviderError("NAVER_BUSY", "Naver request queue is full");
    await new Promise((resolve) => this.queue.push(resolve));
  }
  _release() {
    const next = this.queue.shift();
    if (next) next();
    else this.active -= 1;
  }
  async _withSlot(work) {
    await this._acquire();
    try { return await work(); }
    finally { this._release(); }
  }
  async _attempt(loader) {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const value = await loader();
        if (!retryableStatus(value?.status) || attempt === this.maxAttempts - 1) return value;
      } catch (error) {
        if (!retryableError(error) || attempt === this.maxAttempts - 1) throw error;
      }
      const backoff = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** attempt));
      const jitter = Math.floor(this.randomFn() * this.jitterMs);
      await this.sleepFn(backoff + jitter);
    }
    throw new ProviderError("NAVER_RETRY_EXHAUSTED", "Naver retry budget exhausted");
  }
  async run(key, loader, { ttlMs = 0 } = {}) {
    const cached = this._getCache(key);
    if (cached !== undefined) return cached;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const task = this._withSlot(async () => {
      const value = await this._attempt(loader);
      this._setCache(key, value, ttlMs);
      return value;
    });
    this.inFlight.set(key, task);
    try { return await task; }
    finally { this.inFlight.delete(key); }
  }
}

const controller = new NaverRequestController();
function controlled(key, loader, ttlMs) { return controller.run(key, loader, { ttlMs }); }

export function parsePriceHtml(value) {
  const s = stripTags(value).replaceAll(",", "");
  if (!s || s === "0") return null;
  const m = /^(?:(\d+(?:\.\d+)?)\s*억)?\s*(\d+)?/.exec(s);
  if (!m) return null;
  return Math.round(Number(m[1] || 0) * 10000 + Number(m[2] || 0)) || null;
}

export function parseSearchRedirect(location, query) {
  let u;
  try { u = new URL(location, BASE); }
  catch { throw new ProviderError("NAVER_UNEXPECTED_REDIRECT", "Naver search redirect URL was invalid"); }
  const match = /^\/complex\/info\/(\d+)\/?$/.exec(u.pathname);
  if (u.protocol !== "https:" || u.hostname !== "m.land.naver.com" || !match) {
    throw new ProviderError("NAVER_UNEXPECTED_REDIRECT", `Unexpected Naver search redirect for ${String(query).slice(0, 80)}`);
  }
  return { complex_no: match[1], complex_name: String(query), source_url: u.toString() };
}

export async function searchComplex(query) {
  const s = new HttpSession({ userAgent: UA, maxBytes: 1_000_000 });
  const url = `${BASE}/search/result/${encodeURIComponent(String(query).trim())}`;
  const r = await controlled(`search:${url}`, () => s.request(url, { headers: { accept: "text/html,application/xhtml+xml,*/*" }, redirect: "manual" }), 30_000);
  if (r.status === 302 || r.status === 301) return [parseSearchRedirect(r.location, query)];
  if (r.ok) {
    const ids = [...r.text.matchAll(/\/complex\/info\/(\d+)/g)].map((m) => m[1]);
    return [...new Set(ids)].slice(0, 20).map((id) => ({ complex_no: id, complex_name: null, source_url: `${BASE}/complex/info/${id}` }));
  }
  ensureOk(r, "search");
  return [];
}

export async function complexesByCortar(cortarNo) {
  const s = new HttpSession({ userAgent: UA, maxBytes: 3_000_000 });
  const u = new URL(`${BASE}/complex/ajax/complexListByCortarNo`);
  u.searchParams.set("cortarNo", cortarNo);
  u.searchParams.set("realEstateType", "APT");
  const r = await controlled(`complexes:${u}`, () => s.request(u, { headers: ajaxHeaders() }), 20_000);
  ensureOk(r, "complex list");
  const j = parseJson(r, "complex list");
  return Array.isArray(j.result) ? j.result : [];
}

export async function resolveComplex({ name, region }) {
  const query = [region?.canonical || region?.dong || region?.district || region || "", name].filter(Boolean).join(" ");
  const direct = await searchComplex(query);
  const target = normalizeName(name);
  if (direct.length === 1) {
    const rows = region?.cortar_no ? await complexesByCortar(region.cortar_no) : [];
    const hit = rows.find((x) => String(x.hscpNo) === direct[0].complex_no) || rows.find((x) => normalizeName(x.hscpNm) === target);
    return { ...direct[0], complex_name: hit?.hscpNm || name, lat: hit ? Number(hit.lat) : null, lng: hit ? Number(hit.lng) : null, cortar_no: hit?.cortarNo || region?.cortar_no || null, current_counts: hit ? { sale: hit.dealCnt || 0, jeonse: hit.leaseCnt || 0, monthly_rent: hit.rentCnt || 0 } : null };
  }
  if (region?.cortar_no) {
    const rows = await complexesByCortar(region.cortar_no);
    const hits = rows.filter((x) => normalizeName(x.hscpNm) === target || normalizeName(x.hscpNm).includes(target) || target.includes(normalizeName(x.hscpNm)));
    if (hits.length === 1) {
      const x = hits[0];
      return { complex_no: String(x.hscpNo), complex_name: x.hscpNm, lat: Number(x.lat), lng: Number(x.lng), cortar_no: x.cortarNo, current_counts: { sale: x.dealCnt || 0, jeonse: x.leaseCnt || 0, monthly_rent: x.rentCnt || 0 } };
    }
    if (hits.length > 1) throw new ProviderError("AMBIGUOUS_COMPLEX", `Multiple Naver complexes matched: ${name}`, { candidates: hits.slice(0, 10).map((x) => ({ complex_no: String(x.hscpNo), name: x.hscpNm })) });
  }
  throw new ProviderError("COMPLEX_NOT_FOUND", `No Naver complex matched: ${name}`);
}

export async function listingSummary({ cortarNo, complexNo, complexName, maxPages = 8 }) {
  const s = new HttpSession({ userAgent: UA, maxBytes: 3_000_000 });
  const target = normalizeName(complexName || "");
  for (let page = 1; page <= maxPages; page += 1) {
    const u = new URL(`${BASE}/cluster/ajax/complexList`);
    for (const [k, v] of Object.entries({ cortarNo, rletTpCd: "APT", page: String(page) })) u.searchParams.set(k, v);
    const r = await controlled(`summary:${u}`, () => s.request(u, { headers: ajaxHeaders() }), 15_000);
    ensureOk(r, "listing summary");
    const j = parseJson(r, "listing summary");
    const rows = Array.isArray(j.result) ? j.result : [];
    const hit = rows.find((x) => String(x.hscpNo) === String(complexNo)) || rows.find((x) => target && normalizeName(x.hscpNm) === target);
    if (hit) return {
      source: "NAVER_LAND_PUBLIC",
      complex_no: String(hit.hscpNo),
      complex_name: hit.hscpNm,
      households: Number(hit.totHsehCnt) || null,
      approved_at: hit.useAprvYmd || null,
      current_count: { sale: Number(hit.dealCnt) || 0, jeonse: Number(hit.leaseCnt) || 0, monthly_rent: Number(hit.rentCnt) || 0, total: Number(hit.totalAtclCnt) || 0 },
      asking_price_manwon: { sale_min: parsePriceHtml(hit.dealPrcMin), sale_max: parsePriceHtml(hit.dealPrcMax), jeonse_min: parsePriceHtml(hit.leasePrcMin), jeonse_max: parsePriceHtml(hit.leasePrcMax) },
      supply_area_range_m2: { min: Number(hit.minSpc) || null, max: Number(hit.maxSpc) || null },
      source_url: `https://fin.land.naver.com/complexes/${hit.hscpNo}?tab=article`,
      fetched_at: new Date().toISOString(),
    };
    if (!j.more) break;
    await sleep(350);
  }
  throw new ProviderError("COMPLEX_NOT_FOUND", `Complex ${complexName || complexNo} not found in current Naver listing summaries`);
}

// The anonymous detail endpoint was observed as HTTP 429 on 2026-09-27 and the legacy mobile detail path returned null.
// Until a live row contract can be captured and reviewed, production deliberately exports no individual-row fields.
export const VERIFIED_LISTING_FIELD_ALLOWLIST = Object.freeze([]);

function normalizeUpstreamPrimitive(value) {
  if (typeof value === "string") return value.normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, UPSTREAM_TEXT_MAX);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

export function sanitizeListingRows(rows, size, allowlist = VERIFIED_LISTING_FIELD_ALLOWLIST) {
  const cap = Math.min(100, Math.max(1, Number(size) || 1));
  const allowed = new Set(allowlist);
  const out = [];
  for (const row of (Array.isArray(rows) ? rows : []).slice(0, cap)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const projected = {};
    for (const key of allowed) {
      if (!Object.hasOwn(row, key)) continue;
      const normalized = normalizeUpstreamPrimitive(row[key]);
      if (normalized !== undefined) projected[key] = normalized;
    }
    if (Object.keys(projected).length > 0) out.push(projected);
  }
  return out;
}

export function projectListingRows(rows, size, allowlist = VERIFIED_LISTING_FIELD_ALLOWLIST) {
  const sourceRows = Array.isArray(rows) ? rows : [];
  return { listings: sanitizeListingRows(sourceRows, size, allowlist), contract_verified: sourceRows.length === 0 || allowlist.length > 0 };
}

export async function currentListings({ complexNo, tradeType = "A1", size = 100 }) {
  const s = new HttpSession({ userAgent: UA, maxBytes: 5_000_000 });
  const requestSize = Math.min(100, Math.max(1, size));
  const payload = { complexNumber: String(complexNo), tradeTypes: [tradeType], pyeongTypes: [], dongNumbers: [], userChannelType: "PC", articleSortType: "RANKING_DESC", seed: "", lastInfo: [], size: requestSize };
  const cacheKey = `detail:${complexNo}:${tradeType}:${requestSize}`;
  const r = await controlled(cacheKey, () => s.request(NAVER_DETAIL_URL, { method: "POST", headers: { origin: "https://fin.land.naver.com", referer: `https://fin.land.naver.com/complexes/${complexNo}?tab=transaction` }, json: payload, maxBytes: 5_000_000 }), 10_000);
  ensureOk(r, "current listings");
  const j = parseJson(r, "current listings");
  const res = j.result || {};
  const rows = res.list || res.articles || res.articleList || [];
  const projected = projectListingRows(rows, requestSize);
  if (!projected.contract_verified) {
    throw new ProviderError("NAVER_DETAIL_CONTRACT_UNVERIFIED", "Naver individual listing rows are available but their live field contract has not been verified; aggregate summary remains available", { sourceApi: NAVER_DETAIL_URL });
  }
  const rawTotal = Number(res.totalCount);
  return { total_count: Number.isFinite(rawTotal) ? rawTotal : (Array.isArray(rows) ? rows.length : 0), listings: projected.listings, contract_verified: true, source_api: NAVER_DETAIL_URL };
}

export function isDetailDegradableError(error) { return DETAIL_DEGRADE_CODES.has(error?.code); }
