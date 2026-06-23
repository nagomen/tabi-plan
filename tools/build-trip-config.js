#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const outputPath = path.join(process.cwd(), "docs", "trip-config.js");
const rawConfig = String(process.env.TRIP_CONFIG_JSON || "").trim();

if (!rawConfig) {
  if (!fs.existsSync(outputPath)) {
    throw new Error("docs/trip-config.js is missing and TRIP_CONFIG_JSON is not set.");
  }
  console.log("Using committed docs/trip-config.js");
  process.exit(0);
}

let config;
try {
  config = JSON.parse(rawConfig);
} catch (error) {
  throw new Error(`TRIP_CONFIG_JSON is not valid JSON: ${error.message}`);
}

if (!config || typeof config !== "object" || Array.isArray(config)) {
  throw new Error("TRIP_CONFIG_JSON must be a JSON object.");
}

const requiredFields = ["tripSlug", "tripTitle", "mode", "schema"];
const missingFields = requiredFields.filter((field) => !String(config[field] || "").trim());
if (missingFields.length > 0) {
  throw new Error(`TRIP_CONFIG_JSON is missing required field(s): ${missingFields.join(", ")}`);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `window.TRIP_CONFIG = ${JSON.stringify(config, null, 2)};\n`, "utf8");
console.log(`Wrote ${outputPath} from TRIP_CONFIG_JSON`);
