import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

process.env.SESSION_SECRET ||= "test-session-secret-0123456789-abcdef";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";

const { createTravelMcpServer, TARGET_TRIP_SLUG } = await import("../dist/mcp-server.js");

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
    { userId: "usr_test", scopes: ["trip:expenses:read", "trip:expenses:write"] },
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
      "list_trip_expenses", "create_trip_expense", "update_trip_expense",
      "delete_trip_expense", "restore_trip_expense",
    ]) assert.ok(tools.has(name), `${name} should be registered`);
    assert.equal(tools.get("list_trip_expenses").annotations.readOnlyHint, true);
    assert.equal(tools.get("create_trip_expense").annotations.readOnlyHint, false);
    assert.equal(tools.get("delete_trip_expense").annotations.destructiveHint, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("expense repository is fixed to one trip and does not accept a plan id", () => {
  const source = fs.readFileSync(new URL("../src/mcp-expense-repo.ts", import.meta.url), "utf8");
  assert.match(source, /TARGET_TRIP_SLUG/);
  assert.match(source, /p\.slug = \?/);
  assert.doesNotMatch(source, /createTargetExpense\([\s\S]{0,120}planId/);
  assert.match(source, /pag\.role IN \('owner','editor'\)/);
});

