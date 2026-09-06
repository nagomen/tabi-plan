import test from "node:test";
import assert from "node:assert/strict";

process.env.SESSION_SECRET ||= "test-session-secret-that-is-longer-than-32-characters";
process.env.DB_USER ||= "test";
process.env.DB_PASSWORD ||= "test";
process.env.GOOGLE_ROUTES_API_KEY = "test-google-key";
process.env.AMADEUS_CLIENT_ID = "test-amadeus-id";
process.env.AMADEUS_CLIENT_SECRET = "test-amadeus-secret";

const { searchTransportOptions, transportOptionsForCities } = await import("../dist/transport-search.js");

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
  // 到着時刻は出発と同じオフセット表記。UTC(Z)と混ざると画面の文字列表示がずれる。
  assert.equal(result.options[1].arrival_time, "2026-10-18T03:30:00+08:00");
});

test("モード指定は不要なプロバイダを呼ばない", async () => {
  const flightCalls = [];
  const flightOnly = await searchTransportOptions({
    from: "HND", to: "TPE", date: "2026-10-18", mode: "flight", people: 2,
  }, async (url) => {
    flightCalls.push(String(url));
    if (String(url).includes("/v1/security/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 1800 }), { status: 200 });
    }
    if (String(url).includes("/v2/shopping/flight-offers")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  assert.equal(flightOnly.options.length, 0);
  assert.equal(flightCalls.some((url) => url.includes("routes.googleapis.com")), false);

  const transitCalls = [];
  const transitOnly = await searchTransportOptions({
    from: "東京", to: "大阪", date: "2026-11-01", mode: "transit",
  }, async (url) => {
    transitCalls.push(String(url));
    return new Response(JSON.stringify({ routes: [{ duration: "9000s" }] }), { status: 200 });
  });
  assert.deepEqual(transitCalls.length, 1);
  assert.equal(transitOnly.options[0].mode, "transit");
  assert.equal(transitOnly.options[0].duration_minutes, 150);
  // localizedValuesが無ければ距離・時間の注記は空でよい
  assert.equal(transitOnly.options[0].note, "");
});

test("辞書に無いラテン文字都市はロケーション検索で解決し、結果をキャッシュする", async () => {
  const endpointCalls = { locations: 0, offers: 0 };
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("/v1/security/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 1800 }), { status: 200 });
    }
    if (target.includes("/v1/reference-data/locations")) {
      endpointCalls.locations += 1;
      assert.match(target, /keyword=Fukuoka/);
      return new Response(JSON.stringify({
        data: [{ iataCode: "FUK", subType: "CITY", timeZoneOffset: "+09:00" }],
      }), { status: 200 });
    }
    if (target.includes("/v2/shopping/flight-offers")) {
      endpointCalls.offers += 1;
      assert.match(target, /originLocationCode=FUK/);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (target.includes("routes.googleapis.com")) {
      return new Response(JSON.stringify({ routes: [] }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  };
  await searchTransportOptions({ from: "Fukuoka", to: "台北", date: "2026-10-18", mode: "any" }, fetchImpl);
  await searchTransportOptions({ from: "Fukuoka", to: "台北", date: "2026-10-18", mode: "any" }, fetchImpl);
  assert.equal(endpointCalls.locations, 1, "2回目はキャッシュから解決する");
  assert.equal(endpointCalls.offers, 2);
});

test("空港コードを特定できない都市は警告を返し、他の候補は生かす", async () => {
  const calls = [];
  const result = await searchTransportOptions({
    from: "山間の名もない集落", to: "東京", date: "2026-10-18", mode: "any",
  }, async (url) => {
    calls.push(String(url));
    if (String(url).includes("routes.googleapis.com")) {
      return new Response(JSON.stringify({ routes: [{ duration: "3600s" }] }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  assert.equal(calls.length, 1, "非ラテン文字の未知都市はロケーション検索へも出ない");
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].provider, "google_routes");
  assert.match(result.warnings.join("\n"), /空港コードを特定できない/);
  assert.match(result.warnings.join("\n"), /山間の名もない集落/);
});

test("transportOptionsForCitiesは日付の分かる隣接区間だけを検索する", async () => {
  const searchedPairs = [];
  const options = await transportOptionsForCities([
    { name: "台北", to_date: "2026-10-18" },
    { name: "東京", from_date: "2026-10-18" },
    { name: "高雄" }, // 日付が無いので東京→高雄は検索しない
  ], 2, async (url, init) => {
    const target = String(url);
    if (target.includes("/v1/security/oauth2/token")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 1800 }), { status: 200 });
    }
    if (target.includes("/v2/shopping/flight-offers")) {
      searchedPairs.push(target);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (target.includes("routes.googleapis.com")) {
      searchedPairs.push(JSON.parse(String(init.body)).origin.address);
      return new Response(JSON.stringify({ routes: [{ duration: "5400s" }] }), { status: 200 });
    }
    throw new Error(`unexpected url: ${url}`);
  });
  assert.equal(searchedPairs.filter((entry) => entry.includes("flight-offers")).length, 1);
  assert.deepEqual(searchedPairs.filter((entry) => entry === "台北"), ["台北"]);
  assert.equal(options.every((option) => option.duration_minutes > 0), true);
});
