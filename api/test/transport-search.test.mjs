import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.GOOGLE_ROUTES_API_KEY = "test-google-key";
process.env.AMADEUS_CLIENT_ID = "test-amadeus-id";
process.env.AMADEUS_CLIENT_SECRET = "test-amadeus-secret";

const { searchTransportOptions } = await import("../dist/transport-search.js");

test("移動候補検索は航空券候補と公共交通候補を正規化する", async () => {
  const calls = [];
  const result = await searchTransportOptions({
    from: "台北",
    to: "東京",
    date: "2026-10-18",
    time: "02:00",
    mode: "any",
    people: 1,
  }, async (url, init) => {
    calls.push(String(url));
    if (String(url).includes("/v1/security/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 1800 }), { status: 200 });
    }
    if (String(url).includes("/v2/shopping/flight-offers")) {
      return new Response(JSON.stringify({
        data: [{
          id: "1",
          itineraries: [{
            duration: "PT3H30M",
            segments: [{
              carrierCode: "MM",
              number: "620",
              departure: { iataCode: "TPE", at: "2026-10-18T02:00:00" },
              arrival: { iataCode: "NRT", at: "2026-10-18T06:30:00" },
            }],
          }],
          price: { grandTotal: "26240.00", currency: "JPY" },
        }],
        dictionaries: { carriers: { MM: "Peach" } },
      }), { status: 200 });
    }
    if (String(url).includes("routes.googleapis.com")) {
      const body = JSON.parse(String(init.body));
      assert.equal(body.travelMode, "TRANSIT");
      assert.equal(body.departureTime, "2026-10-18T02:00:00+08:00");
      return new Response(JSON.stringify({
        routes: [{
          duration: "5400s",
          distanceMeters: 120000,
          localizedValues: { duration: { text: "1時間30分" }, distance: { text: "120 km" } },
          legs: [{ steps: [{ travelMode: "TRANSIT", transitDetails: { transitLine: { nameShort: "鉄道" } } }] }],
        }],
      }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });

  assert.equal(calls.length, 3);
  assert.equal(result.warnings.length, 0);
  assert.equal(result.options[0].mode, "flight");
  assert.equal(result.options[0].provider, "amadeus");
  assert.equal(result.options[0].duration_minutes, 210);
  assert.equal(result.options[0].flight_number, "MM620");
  assert.equal(result.options[1].mode, "transit");
  assert.equal(result.options[1].provider, "google_routes");
  assert.equal(result.options[1].duration_minutes, 90);
});
