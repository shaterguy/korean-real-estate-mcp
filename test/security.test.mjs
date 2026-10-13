import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { isAllowedLoopbackRequest, TOOL_NAMES } from "../src/server.mjs";
import { runWithRequestSignal } from "../src/request-context.mjs";
import { HttpSession } from "../src/providers/http.mjs";

const init = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "security-test", version: "1.0" } },
});

async function launch(t) {
  const child = spawn(process.execPath, [".local/server.mjs"], {
    env: { ...process.env, PORT: "0" }, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  return await new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("server startup timed out: " + output)), 5000);
    child.stdout.on("data", (data) => {
      output += data.toString();
      const found = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (found) { clearTimeout(timer); resolve(Number(found[1])); }
    });
    child.stderr.on("data", (data) => { output += data.toString(); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error("server exited " + code + ": " + output)); });
    child.once("error", reject);
  });
}

function request(port, { host = "127.0.0.1:" + port, origin, body = init, path = "/mcp", method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, accept: "application/json, text/event-stream" };
    if (method === "POST") {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(body);
    }
    if (origin !== undefined) headers.origin = origin;
    const req = http.request({ hostname: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (data) => chunks.push(data));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.once("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}

test("loopback authority enforces exact Host and present Origin", async (t) => {
  assert.equal(TOOL_NAMES.length, 11);
  const port = await launch(t);
  assert.equal(isAllowedLoopbackRequest({ host: "127.0.0.1:" + port }, port), true);
  assert.equal(isAllowedLoopbackRequest({ host: "localhost:" + port, origin: "http://localhost:" + port }, port), true);
  assert.equal(isAllowedLoopbackRequest({ host: "127.0.0.1:" + port, origin: "null" }, port), false);
  assert.equal((await request(port, { host: "evil.test:" + port, body: "{" })).status, 403);
  assert.equal((await request(port, { origin: "http://evil.test:" + port, body: "{" })).status, 403);
  assert.equal((await request(port, { origin: "null", body: "{" })).status, 403);
  assert.equal((await request(port, { host: "127.0.0.1", body: "{" })).status, 403);
  assert.equal((await request(port, { host: "evil.test:" + port, path: "/health", method: "GET" })).status, 403);
  const withoutOrigin = await request(port);
  assert.equal(withoutOrigin.status, 200, withoutOrigin.text);
  assert.equal(JSON.parse(withoutOrigin.text).result?.serverInfo?.name, "korean-real-estate-mcp");
  const withOrigin = await request(port, { origin: "http://127.0.0.1:" + port });
  assert.equal(withOrigin.status, 200, withOrigin.text);
  assert.equal((await request(port, { path: "/health", method: "GET" })).status, 200);
});

test("inbound MCP request admission is globally bounded and recovers after disconnect", async (t) => {
  const port = await launch(t);
  const blockers = Array.from({ length: 8 }, () => {
    const req = http.request({
      hostname: "127.0.0.1", port, path: "/mcp", method: "POST",
      headers: { host: "127.0.0.1:" + port, "content-type": "application/json", "content-length": "200" },
    });
    req.on("error", () => {});
    req.write("{");
    return req;
  });
  try {
    await sleep(120);
    const refused = await request(port);
    assert.equal(refused.status, 429);
    assert.equal(refused.headers["retry-after"], "1");
  } finally {
    blockers.forEach((req) => req.destroy());
  }
  await sleep(120);
  const accepted = await request(port);
  assert.equal(accepted.status, 200, accepted.text);
});

test("POST 307 and 308 must not forward a body to another provider authority", async () => {
  for (const status of [307, 308]) {
    const called = [];
    const fetchImpl = async (url, options) => {
      called.push({ url: String(url), method: options.method, body: options.body });
      return new Response("", { status, headers: { location: "https://fin.land.naver.com/next" } });
    };
    const session = new HttpSession({ fetchImpl });
    await assert.rejects(
      () => session.request("https://m.land.naver.com/start", { method: "POST", body: "private-query=sample" }),
      (error) => error?.code === "CROSS_ORIGIN_BODY_REDIRECT",
    );
    assert.equal(called.length, 1);
  }
  const called = [];
  const session = new HttpSession({ fetchImpl: async (url, options) => {
    called.push({ url: String(url), method: options.method, body: options.body });
    return called.length === 1
      ? new Response("", { status: 307, headers: { location: "/new-path" } })
      : new Response("ok", { status: 200 });
  } });
  const response = await session.request("https://m.land.naver.com/start", { method: "POST", body: "safe-body=sample" });
  assert.equal(response.text, "ok");
  assert.deepEqual(called.map((call) => call.method), ["POST", "POST"]);
  assert.equal(called[1].body, "safe-body=sample");
});

test("provider requests share process-wide concurrency slots", async () => {
  let active = 0;
  let peak = 0;
  const fetchImpl = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(25);
    active -= 1;
    return new Response("ok", { status: 200 });
  };
  await Promise.all(Array.from({ length: 9 }, () => new HttpSession({ fetchImpl, timeoutMs: 4000 }).request("https://rt.molit.go.kr/safe")));
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test("Nominatim calls are paced across independent HTTP sessions", async () => {
  const times = [];
  const fetchImpl = async () => {
    times.push(Date.now());
    return new Response("ok", { status: 200 });
  };
  await Promise.all(Array.from({ length: 2 }, () =>
    new HttpSession({ fetchImpl, timeoutMs: 4000 }).request("https://nominatim.openstreetmap.org/search")));
  assert.equal(times.length, 2);
  assert.ok(times[1] - times[0] >= 950, String(times[1] - times[0]));
});

test("client cancellation propagates through request context into stalled provider body", async () => {
  let cancelledBody = false;
  const cancel = new AbortController();
  const fetchImpl = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([65])); },
    pull() { return new Promise(() => {}); },
    cancel() { cancelledBody = true; },
  }), { status: 200 });
  const session = new HttpSession({ fetchImpl, timeoutMs: 5000 });
  const pending = runWithRequestSignal(cancel.signal, () => session.request("https://rt.molit.go.kr/slow"));
  setTimeout(() => cancel.abort(), 30);
  await assert.rejects(() => pending, (error) => error?.code === "REQUEST_CANCELLED");
  assert.equal(cancelledBody, true);
});
