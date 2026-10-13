import http from "node:http";
import { createMcpServer, isAllowedLoopbackRequest } from "../src/server.mjs";
import { runWithRequestSignal } from "../src/request-context.mjs";

const port = Number(process.env.PORT || "17847");
const MAX_IN_FLIGHT = 8;
let inFlight = 0;

async function bodyJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 262144) throw new Error("PAYLOAD_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const app = http.createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const listeningPort = app.address()?.port ?? port;
  if (!isAllowedLoopbackRequest(req.headers, listeningPort)) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "forbidden_authority" }));
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, service: "korean-real-estate-mcp", version: "0.1.0-dev2", transport: "streamable-http", loopback: true, read_only: true, required_secrets: [] }));
    return;
  }
  if (req.method !== "POST" || req.url !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
    return;
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    res.writeHead(429, { "content-type": "application/json; charset=utf-8", "retry-after": "1" });
    res.end(JSON.stringify({ error: "server_busy" }));
    return;
  }

  inFlight += 1;
  const cancelled = new AbortController();
  req.once("aborted", () => cancelled.abort());
  res.once("close", () => { if (!res.writableEnded) cancelled.abort(); });
  let built;
  try {
    const parsed = await bodyJson(req);
    if (cancelled.signal.aborted) return;
    built = createMcpServer();
    res.once("close", () => {
      void built.transport.close().catch(() => {});
      void built.server.close().catch(() => {});
    });
    await runWithRequestSignal(cancelled.signal, async () => {
      await built.server.connect(built.transport);
      await built.transport.handleRequest(req, res, parsed);
    });
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null }));
    } else if (!res.writableEnded) res.end();
  } finally {
    inFlight -= 1;
  }
});
app.listen(port, "127.0.0.1", () => console.log("korean-real-estate-mcp listening on 127.0.0.1:" + app.address().port));
