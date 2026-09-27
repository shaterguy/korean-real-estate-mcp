import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TOOL_NAMES, TOOL_INPUT_SCHEMAS } from "../src/server.mjs";
import { HttpSession } from "../src/providers/http.mjs";
import { NaverRequestController, VERIFIED_LISTING_FIELD_ALLOWLIST, parsePriceHtml, parseSearchRedirect, projectListingRows, sanitizeListingRows } from "../src/providers/naver-land.mjs";
import { dedupeSourceRows, parseCsv } from "../src/providers/rtms.mjs";
import { normalizeName } from "../src/common.mjs";
import { groupByArea, groupFacilities, midpointRegionQuery, selectActualComparison } from "../src/services.mjs";

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

test("HTTP total timeout covers response body consumption", async () => {
  let canceled = false;
  const fetchImpl = async () => {
    let timer;
    const stream = new ReadableStream({
      start(controller) {
        timer = setTimeout(() => {
          controller.enqueue(new TextEncoder().encode("late"));
          controller.close();
        }, 80);
      },
      cancel() {
        canceled = true;
        clearTimeout(timer);
      },
    });
    return new Response(stream, { status: 200 });
  };
  const session = new HttpSession({ fetchImpl, timeoutMs: 20 });
  await assert.rejects(() => session.request("https://m.land.naver.com/slow"), (e) => e?.code === "UPSTREAM_TIMEOUT");
  assert.equal(canceled, true);
});

test("HTTP maxBytes is enforced while streaming unknown or understated bodies", async () => {
  for (const headers of [{}, { "content-length": "1" }]) {
    let canceled = false;
    let pulls = 0;
    const fetchImpl = async () => new Response(new ReadableStream({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(10));
      },
      cancel() {
        canceled = true;
      },
    }), { status: 200, headers });
    const session = new HttpSession({ fetchImpl, maxBytes: 16 });
    await assert.rejects(() => session.request("https://m.land.naver.com/chunked"), (e) => e?.code === "RESPONSE_TOO_LARGE");
    assert.equal(canceled, true);
    assert.ok(pulls < 10);
  }
});

test("HTTP cookies and host-bound credentials do not cross origins on redirects", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    const captured = Object.fromEntries(new Headers(options.headers).entries());
    seen.push({ url: String(url), headers: captured });
    if (seen.length === 1) {
      return new Response("", {
        status: 302,
        headers: {
          location: "https://overpass-api.de/next",
          "set-cookie": "sid=naver-secret; Path=/",
        },
      });
    }
    return new Response("ok", { status: 200 });
  };
  const session = new HttpSession({ fetchImpl });
  await session.request("https://m.land.naver.com/start", {
    headers: {
      Authorization: "Bearer synthetic",
      "Proxy-Authorization": "Basic synthetic",
      Cookie: "manual=initial",
    },
  });
  assert.equal(seen[0].headers.authorization, "Bearer synthetic");
  assert.equal(seen[0].headers.cookie, "manual=initial");
  assert.equal(seen[1].headers.authorization, undefined);
  assert.equal(seen[1].headers["proxy-authorization"], undefined);
  assert.equal(seen[1].headers.cookie, undefined);

  await session.request("https://m.land.naver.com/again");
  assert.equal(seen[2].headers.cookie, "sid=naver-secret");
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


test("market area statistics include min/median/average/max", () => {
  const grouped = groupByArea([
    { exclusive_area_m2: 84.9, price_manwon: 70000 },
    { exclusive_area_m2: 84.8, price_manwon: 74000 },
    { exclusive_area_m2: 84.7, price_manwon: 76000 },
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].avg_price_manwon, 73333.3);
  assert.equal(grouped[0].median_price_manwon, 74000);
  assert.equal(grouped[0].min_price_manwon, 70000);
  assert.equal(grouped[0].max_price_manwon, 76000);
  assert.deepEqual(grouped[0].price_manwon, { count: 3, min: 70000, median: 74000, average: 73333.3, max: 76000 });
});

test("Overpass fallback continues after a network failure", async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes("overpass-api.de")) throw new Error("synthetic first endpoint failure");
    return new Response(JSON.stringify({ elements: [{ type: "node", id: 1, lat: 37.6, lon: 127.1, tags: { amenity: "school", name: "테스트학교" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const places = await import("../src/providers/places.mjs?fallback-test="+Date.now());
    const result = await places.nearby({ lat: 37.6, lon: 127.1, radius: 300, categories: ["school"] });
    assert.equal(result.items[0].name, "테스트학교");
    assert.ok(seen.some(x => x.includes("overpass-api.de")));
    assert.ok(seen.some(x => x.includes("overpass.kumi.systems")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("compatibility facility grouping separates stations schools and childcare", () => {
  const g = groupFacilities([
    { name: "역", railway: "station", amenity: null, station: null },
    { name: "학교", railway: null, amenity: "school", station: null },
    { name: "어린이집", railway: null, amenity: "childcare", station: null },
  ]);
  assert.equal(g.stations.length, 1);
  assert.equal(g.schools.length, 1);
  assert.equal(g.childcare.length, 1);
});


test("RTMS source-row dedupe preserves distinct official rows", () => {
  const rows = [
    { NO: "285", "계약일": "11", "보증금(만원)": "10,000" },
    { NO: "286", "계약일": "11", "보증금(만원)": "10,000" },
    { NO: "285", "계약일": "11", "보증금(만원)": "10,000" },
  ];
  const out = dedupeSourceRows(rows);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((x) => x.NO), ["285", "286"]);
});
