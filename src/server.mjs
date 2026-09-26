import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { failure, success } from "./common.mjs";
import * as svc from "./services.mjs";

const annotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const outputSchema = { ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), retry_after_sec: z.number().optional(), candidates: z.unknown().optional() }).optional(), meta: z.object({ source: z.string(), source_api: z.string().optional(), as_of: z.string(), cached: z.boolean(), request_id: z.string() }), warnings: z.array(z.string()).optional() };
const requiredText = (max = 200) => z.string().trim().min(1).max(max);
const optionalText = (max = 80) => z.string().trim().max(max).optional();
const defaultText = (value, max = 80) => z.string().trim().max(max).default(value);

export const TOOL_INPUT_SCHEMAS = Object.freeze({
  search_property: { region: requiredText(200), property_type: defaultText("아파트", 40), trade_type: defaultText("매매", 40), min_price: z.number().min(0).default(0), max_price: z.number().min(0).default(999999), size_type: optionalText(80), rent_type: optionalText(80), max_results: z.number().int().min(1).max(50).default(5), sort_by: z.enum(["최신순", "살기좋은순"]).default("최신순") },
  get_market_price: { apartment_name: requiredText(200), region: defaultText("", 200), property_type: defaultText("아파트", 40), months: z.number().int().min(1).max(12).default(6) },
  find_midpoint_property: { location_a: requiredText(200), location_b: requiredText(200), property_type: defaultText("아파트", 40), trade_type: defaultText("매매", 40), max_price: z.number().min(0).default(999999), max_results: z.number().int().min(1).max(50).default(5) },
  resolve_region: { query: requiredText(200) },
  resolve_complex: { name: requiredText(200), region: defaultText("", 200) },
  get_actual_transactions: { region: requiredText(200), complex_name: optionalText(200), months: z.number().int().min(1).max(12).default(6), transaction_type: z.enum(["sale", "lease"]).default("sale"), limit: z.number().int().min(1).max(500).default(100) },
  get_current_listings: { region: requiredText(200), complex_name: requiredText(200), trade_type: z.enum(["매매", "전세", "월세", "A1", "B1", "B2"]).default("매매"), limit: z.number().int().min(1).max(100).default(100) },
  get_listing_summary: { region: requiredText(200), complex_name: requiredText(200) },
  compare_actual_vs_asking: { region: requiredText(200), complex_name: requiredText(200), months: z.number().int().min(1).max(12).default(6), area_m2: z.number().positive().optional(), area_tolerance_m2: z.number().min(0).max(20).default(3) },
  get_nearby_facilities: { region: requiredText(200), complex_name: requiredText(200), radius: z.number().int().min(200).max(3000).default(1200) },
  system_health: {},
});

function register(server, name, description, inputSchema, handler, source = "COMPUTED") {
  server.registerTool(name, { title: name, description, inputSchema, outputSchema, annotations }, async (args) => {
    try { const data = await handler(args); const warnings = data?.warnings || []; return success(data, { source, sourceApi: data?.source_api, warnings }); }
    catch (e) { return failure(e, { source, sourceApi: e?.sourceApi }); }
  });
}

export const TOOL_NAMES = Object.freeze(Object.keys(TOOL_INPUT_SCHEMAS));

export function createMcpServer() {
  const server = new McpServer({ name: "korean-real-estate-mcp", version: "0.1.0-dev2" });
  register(server, "search_property", "PlayMCP-compatible property search using MOLIT actual transactions plus current Naver asking summaries.", TOOL_INPUT_SCHEMAS.search_property, svc.searchProperty);
  register(server, "get_market_price", "PlayMCP-compatible apartment market view separating reported transactions and current asking prices.", TOOL_INPUT_SCHEMAS.get_market_price, svc.marketPrice);
  register(server, "find_midpoint_property", "PlayMCP-compatible geometric midpoint property lookup; does not claim commute-time balancing.", TOOL_INPUT_SCHEMAS.find_midpoint_property, svc.midpointProperty);
  register(server, "resolve_region", "Resolve Korean region text to RTMS legal-district and Naver cortar codes.", TOOL_INPUT_SCHEMAS.resolve_region, (a) => svc.resolveRegion(a.query), "MOLIT_RTMS");
  register(server, "resolve_complex", "Resolve an apartment name to a Naver complex with coordinates and current inventory counts.", TOOL_INPUT_SCHEMAS.resolve_complex, (a) => svc.resolveComplex(a.name, a.region), "NAVER_LAND_PUBLIC");
  register(server, "get_actual_transactions", "Get MOLIT reported apartment sale or lease transactions.", TOOL_INPUT_SCHEMAS.get_actual_transactions, svc.actualTransactions, "MOLIT_RTMS");
  register(server, "get_current_listings", "Get current Naver registered listings when the individual endpoint and verified output contract are available; always returns verified aggregate inventory summary as fallback.", TOOL_INPUT_SCHEMAS.get_current_listings, svc.currentListings, "NAVER_LAND_PUBLIC");
  register(server, "get_listing_summary", "Get Naver current registered-listing counts and asking-price range for a complex.", TOOL_INPUT_SCHEMAS.get_listing_summary, svc.currentListingSummary, "NAVER_LAND_PUBLIC");
  register(server, "compare_actual_vs_asking", "Compare MOLIT reported sale prices with Naver current asking aggregates. When an area is requested, actual transactions are area-filtered and size-specific premium is omitted unless size-specific asking data exists.", TOOL_INPUT_SCHEMAS.compare_actual_vs_asking, svc.compareActualVsAsking);
  register(server, "get_nearby_facilities", "Get nearby schools, childcare and rail/subway stations from OpenStreetMap Overpass.", TOOL_INPUT_SCHEMAS.get_nearby_facilities, svc.nearbyFacilities, "OPENSTREETMAP");
  register(server, "system_health", "Report provider and secret status.", TOOL_INPUT_SCHEMAS.system_health, svc.health);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  return { server, transport };
}
