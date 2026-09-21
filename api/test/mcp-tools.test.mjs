import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { createTravelMcpServer, TARGET_TRIP_SLUG } = await import("../dist/mcp-server.js");
const { validateMcpItineraryItem } = await import("../dist/mcp-itinerary-repo.js");

const trip = {
  plan: {
    id: "pln_test", slug: TARGET_TRIP_SLUG, title: "香港・マカオ・金門旅行", note: null,
    start_date: "2026-10-01", end_date: "2026-10-10", dates_label: null, version: 1,
    updated_at: "2026-09-22 00:00:00",
  },
  cities: [], itinerary: [], links: [],
};

test("MCP lists trip-scoped itinerary and expense tools with correct safety hints", async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createTravelMcpServer(
    { userId: "usr_test", scopes: ["trip:expenses:read", "trip:expenses:write", "trip:itinerary:write"] },
    async () => trip,
  );
  const client = new Client({ name: "test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    for (const name of [
      "get_trip_overview", "get_itinerary", "search_itinerary", "get_trip_links",
      "list_deleted_itinerary_items", "create_itinerary_item", "update_itinerary_item",
      "move_itinerary_item", "delete_itinerary_item", "restore_itinerary_item",
      "list_trip_expenses", "create_trip_expense", "update_trip_expense",
      "delete_trip_expense", "restore_trip_expense",
    ]) assert.ok(tools.has(name), `${name} should be registered`);
    assert.equal(tools.get("list_trip_expenses").annotations.readOnlyHint, true);
    assert.equal(tools.get("create_trip_expense").annotations.readOnlyHint, false);
    assert.equal(tools.get("delete_trip_expense").annotations.destructiveHint, true);
    assert.equal(tools.get("create_itinerary_item").annotations.idempotentHint, true);
    assert.equal(tools.get("delete_itinerary_item").annotations.destructiveHint, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("itinerary repository is fixed to one trip and enforces versioned editor writes", () => {
  const source = fs.readFileSync(new URL("../src/mcp-itinerary-repo.ts", import.meta.url), "utf8");
  assert.match(source, /TARGET_TRIP_SLUG/);
  assert.match(source, /p\.slug = \?/);
  assert.match(source, /pag\.role IN \('owner','editor'\)/);
  assert.match(source, /VersionConflict/);
  assert.match(source, /itinerary_audit_logs/);
  assert.match(source, /mcp_itinerary_requests/);
  assert.doesNotMatch(source, /createTargetItineraryItem\([\s\S]{0,160}planId/);
});

test("itinerary writes validate the title, date, and time before reaching MySQL", () => {
  const valid = {
    item_date: "2026-10-02", day_index: 1, kind: "move", start_time: "09:30",
    title: "香港からマカオへ移動", place: null, area: "香港", note: null, map_query: null,
    lat: null, lng: null, from_place: "香港", from_lat: null, from_lng: null,
    to_place: "マカオ", to_lat: null, to_lng: null, transport: "フェリー",
    duration_minutes: 60, member_ids: null,
  };
  assert.doesNotThrow(() => validateMcpItineraryItem(valid));
  assert.throws(() => validateMcpItineraryItem({ ...valid, title: " " }), /タイトル/);
  assert.throws(() => validateMcpItineraryItem({ ...valid, item_date: "2026-02-31" }), /日付/);
  assert.throws(() => validateMcpItineraryItem({ ...valid, start_time: "25:00" }), /時刻/);
});

test("expense repository is fixed to one trip and does not accept a plan id", () => {
  const source = fs.readFileSync(new URL("../src/mcp-expense-repo.ts", import.meta.url), "utf8");
  assert.match(source, /TARGET_TRIP_SLUG/);
  assert.match(source, /p\.slug = \?/);
  assert.doesNotMatch(source, /createTargetExpense\([\s\S]{0,120}planId/);
  assert.match(source, /pag\.role IN \('owner','editor'\)/);
});
