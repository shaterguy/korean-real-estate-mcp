import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TOOL_NAMES, TOOL_INPUT_SCHEMAS } from "../src/server.mjs";
import { HttpSession } from "../src/providers/http.mjs";
import { NaverRequestController, VERIFIED_LISTING_FIELD_ALLOWLIST, parsePriceHtml, parseSearchRedirect, projectListingRows, sanitizeListingRows } from "../src/providers/naver-land.mjs";
import { parseCsv } from "../src/providers/rtms.mjs";
import { normalizeName } from "../src/common.mjs";
import { midpointRegionQuery, selectActualComparison } from "../src/services.mjs";

test("required tool surface", () => {
  for (const n of ["search_property", "get_market_price", "find_midpoint_property", "get_current_listings", "compare_actual_vs_asking", "system_health"]) assert.ok(TOOL_NAMES.includes(n));
});

test("naver price html parsing", () => {
  assert.equal(parsePriceHtml("7<em class='txt_unit'>억</em> 5,000"), 75000);
  assert.equal(parsePriceHtml("11<em class='txt_unit'>억</em>"), 110000);
});

test("complex name normalization", () => {
  assert.equal(normalizeName(" 성원 2차 아파트 "), normalizeName("성원2차"));
});

test("RTMS CSV parser preserves quoted commas", () => {
  const text = '설명줄\nNO,시군구,단지명,거래금액(만원)\n1,경기도 구리시 인창동,성원2차,"79,000"\n';
  const rows = parseCsv(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]["거래금액(만원)"], "79,000");
});

test("midpoint region keeps district-level Korean address context", () => {
  assert.equal(midpointRegionQuery({ city: "서울특별시", borough: "서초구", suburb: "양재1동" }), "서울특별시 서초구");
  assert.equal(midpointRegionQuery({ state: "경기도", city: "성남시", borough: "분당구" }), "경기도 성남시 분당구");
});

test("area-specific actual comparison never substitutes another size", () => {
  const tx = [
    { exclusive_area_m2: 134.64, price_manwon: 85000, contract_date: "2026-08-18" },
    { exclusive_area_m2: 84.99, price_manwon: 75000, contract_date: "2026-05-18" },
    { exclusive_area_m2: 59.97, price_manwon: 74800, contract_date: "2026-06-21" },
  ];
  const r = selectActualComparison(tx, { area_m2: 84.99, area_tolerance_m2: 3 });
  assert.equal(r.rows.length, 1);
  assert.equal(r.latest.exclusive_area_m2, 84.99);
  assert.equal(r.latest.price_manwon, 75000);
});

test("all free-text MCP inputs have finite maximum lengths", () => {
  assert.equal(z.object(TOOL_INPUT_SCHEMAS.resolve_region).safeParse({ query: "가".repeat(201) }).success, false);
  assert.equal(z.object(TOOL_INPUT_SCHEMAS.find_midpoint_property).safeParse({ location_a: "가".repeat(201), location_b: "여의도역" }).success, false);
  assert.equal(z.object(TOOL_INPUT_SCHEMAS.search_property).safeParse({ region: "서울", size_type: "1".repeat(81) }).success, false);
  assert.equal(z.object(TOOL_INPUT_SCHEMAS.get_market_price).safeParse({ apartment_name: "성원2차", property_type: "아".repeat(41) }).success, false);
});

test("HTTP redirects revalidate every hop and reject off-allowlist destinations", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("", { status: 302, headers: { location: "https://example.com/escape" } });
  };
  const session = new HttpSession({ fetchImpl });
  await assert.rejects(() => session.request("https://m.land.naver.com/start"), (e) => e?.code === "HOST_NOT_ALLOWED");
  assert.equal(calls, 1);
});

test("HTTP redirect hop limit is bounded", async () => {
  const fetchImpl = async (url) => new Response("", { status: 302, headers: { location: new URL("/again", url).toString() } });
  const session = new HttpSession({ fetchImpl, maxRedirects: 1 });
  await assert.rejects(() => session.request("https://m.land.naver.com/start"), (e) => e?.code === "TOO_MANY_REDIRECTS");
});

test("Naver search only accepts the verified mobile complex redirect shape", () => {
  const good = parseSearchRedirect("https://m.land.naver.com/complex/info/4565", "인창동 성원2차");
  assert.equal(good.complex_no, "4565");
  assert.throws(() => parseSearchRedirect("https://example.com/complex/info/4565", "성원2차"), (e) => e?.code === "NAVER_UNEXPECTED_REDIRECT");
  assert.throws(() => parseSearchRedirect("https://m.land.naver.com/other/4565", "성원2차"), (e) => e?.code === "NAVER_UNEXPECTED_REDIRECT");
});

test("Naver controller retries transient statuses with a bounded attempt budget", async () => {
  let calls = 0;
  const sleeps = [];
  const c = new NaverRequestController({ maxAttempts: 3, baseDelayMs: 10, jitterMs: 0, sleepFn: async (ms) => sleeps.push(ms), randomFn: () => 0 });
  const value = await c.run("retry", async () => {
    calls += 1;
    return { status: calls === 1 ? 500 : calls === 2 ? 429 : 200, ok: calls === 3 };
  });
  assert.equal(value.status, 200);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 20]);
});

test("Naver controller deduplicates identical in-flight queries", async () => {
  let calls = 0;
  const c = new NaverRequestController({ maxAttempts: 1 });
  const loader = async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return { status: 200, ok: true, marker: calls }; };
  const [a, b] = await Promise.all([c.run("same", loader), c.run("same", loader)]);
  assert.equal(calls, 1);
  assert.equal(a.marker, b.marker);
});

test("Naver controller enforces its concurrency ceiling", async () => {
  let active = 0;
  let maxActive = 0;
  const c = new NaverRequestController({ maxConcurrency: 2, maxAttempts: 1 });
  const loader = async () => { active += 1; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 8)); active -= 1; return { status: 200, ok: true }; };
  await Promise.all(["a", "b", "c", "d"].map((key) => c.run(key, loader)));
  assert.equal(maxActive, 2);
});

test("Naver current-data cache is short-lived and query scoped", async () => {
  let calls = 0;
  const c = new NaverRequestController({ maxAttempts: 1 });
  const loader = async () => { calls += 1; return { status: 200, ok: true, calls }; };
  const a = await c.run("cache-key", loader, { ttlMs: 1000 });
  const b = await c.run("cache-key", loader, { ttlMs: 1000 });
  assert.equal(calls, 1);
  assert.equal(a.calls, b.calls);
});

test("unverified Naver listing fields are never exported and verified projections are normalized", () => {
  assert.deepEqual(VERIFIED_LISTING_FIELD_ALLOWLIST, []);
  const raw = [{ title: "A\u0000  B", price: 123, nested: { token: "x" }, extra: "do-not-export" }, { title: "second", price: 456 }];
  const production = projectListingRows(raw, 2);
  assert.equal(production.contract_verified, false);
  assert.deepEqual(production.listings, []);
  const verifiedFixture = sanitizeListingRows(raw, 1, ["title", "price"]);
  assert.deepEqual(verifiedFixture, [{ title: "A B", price: 123 }]);
  assert.equal(Object.hasOwn(verifiedFixture[0], "extra"), false);
  assert.equal(Object.hasOwn(verifiedFixture[0], "nested"), false);
});
