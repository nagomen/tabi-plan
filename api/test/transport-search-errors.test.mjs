import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.GOOGLE_ROUTES_API_KEY = "test-google-key";
process.env.AMADEUS_CLIENT_ID = "test-amadeus-id";
process.env.AMADEUS_CLIENT_SECRET = "test-amadeus-secret";

const { searchTransportOptions } = await import("../dist/transport-search.js");

test("Amadeus認証の失敗は警告になり、他プロバイダの候補は返す", async () => {
  const result = await searchTransportOptions({
    from: "台北", to: "東京", date: "2026-10-18", mode: "any",
  }, async (url) => {
    if (String(url).includes("/v1/security/oauth2/token")) {
      return new Response("denied", { status: 500 });
    }
    if (String(url).includes("routes.googleapis.com")) {
      return new Response(JSON.stringify({ routes: [{ duration: "5400s" }] }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].provider, "google_routes");
  assert.match(result.warnings.join("\n"), /amadeus auth failed: 500/);
});

test("Google Routesの失敗は警告になり、航空券候補は返す", async () => {
  const result = await searchTransportOptions({
    from: "台北", to: "東京", date: "2026-10-18", mode: "any",
  }, async (url) => {
    if (String(url).includes("/v1/security/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 1800 }), { status: 200 });
    }
    if (String(url).includes("/v2/shopping/flight-offers")) {
      return new Response(JSON.stringify({
        data: [{
          id: "1",
          itineraries: [{
            duration: "PT2H",
            segments: [{
              carrierCode: "CI", number: "100",
              departure: { iataCode: "TPE", at: "2026-10-18T09:00:00" },
              arrival: { iataCode: "NRT", at: "2026-10-18T13:00:00" },
            }],
          }],
          price: { grandTotal: "30000", currency: "JPY" },
        }],
      }), { status: 200 });
    }
    if (String(url).includes("routes.googleapis.com")) {
      return new Response("boom", { status: 503 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].provider, "amadeus");
  assert.equal(result.options[0].flight_number, "CI100");
  assert.match(result.warnings.join("\n"), /google routes failed: 503/);
});

test("from/to/dateが欠けた検索は警告だけを返す", async () => {
  const result = await searchTransportOptions({ from: "東京", to: "", date: "2026-10-18" }, async () => {
    throw new Error("プロバイダを呼んではいけない");
  });
  assert.deepEqual(result.options, []);
  assert.match(result.warnings.join("\n"), /from\/to\/date/);
});

test("ロケーション検索の失敗は航空券側の警告として返す", async () => {
  const result = await searchTransportOptions({
    from: "Sapporo", to: "東京", date: "2026-10-18", mode: "any",
  }, async (url) => {
    if (String(url).includes("/v1/security/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 1800 }), { status: 200 });
    }
    if (String(url).includes("/v1/reference-data/locations")) {
      return new Response("nope", { status: 502 });
    }
    if (String(url).includes("routes.googleapis.com")) {
      return new Response(JSON.stringify({ routes: [] }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  assert.deepEqual(result.options, []);
  assert.match(result.warnings.join("\n"), /amadeus location lookup failed: 502/);
});
