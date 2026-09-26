import { randomUUID } from "node:crypto";

export class ProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    Object.assign(this, extra);
  }
}

export function success(data, { source = "COMPUTED", sourceApi, warnings = [], cached = false } = {}) {
  const payload = { ok: true, data, meta: { source, source_api: sourceApi, as_of: new Date().toISOString(), cached, request_id: `req_${randomUUID()}` }, warnings };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

export function failure(error, { source = "COMPUTED", sourceApi, warnings = [] } = {}) {
  const payload = {
    ok: false,
    error: { code: error?.code || "UPSTREAM_ERROR", message: error instanceof Error ? error.message : String(error), ...(error?.retry_after_sec ? { retry_after_sec: error.retry_after_sec } : {}), ...(error?.candidates ? { candidates: error.candidates } : {}) },
    meta: { source, source_api: sourceApi || error?.sourceApi, as_of: new Date().toISOString(), cached: false, request_id: `req_${randomUUID()}` }, warnings,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
export function stripTags(value) { return String(value ?? "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim(); }
export function numberValue(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  const n = Number(String(value).replaceAll(",", "").replace(/[^0-9+\-.]/g, ""));
  return Number.isFinite(n) ? n : null;
}
export function normalizeName(value) {
  return String(value ?? "").normalize("NFKC").toLowerCase().replace(/아파트/g, "").replace(/[\s·._-]+/g, "").replace(/[^0-9a-z가-힣]/g, "");
}
export function monthsAgoDate(months) {
  const d = new Date();
  d.setHours(0,0,0,0); d.setMonth(d.getMonth() - months); return d;
}
export function isoDate(d) { return d.toISOString().slice(0,10); }
