#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function checkScript(relativePath) {
  new vm.Script(read(relativePath), { filename: relativePath });
  console.log(`OK ${relativePath}`);
}

function checkJson(relativePath) {
  JSON.parse(read(relativePath));
  console.log(`OK ${relativePath}`);
}

function loadTripConfig() {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(read("docs/trip-config.js"), sandbox, { filename: "docs/trip-config.js" });
  const config = sandbox.window.TRIP_CONFIG;
  if (!config || typeof config !== "object") {
    throw new Error("docs/trip-config.js must assign window.TRIP_CONFIG.");
  }

  const allowedModes = new Set(["sample", "googleSheets", "appsScript"]);
  if (!allowedModes.has(config.mode)) {
    throw new Error(`Unsupported TRIP_CONFIG mode: ${config.mode}`);
  }
  if (!String(config.tripSlug || "").trim()) {
    throw new Error("TRIP_CONFIG.tripSlug is required.");
  }
  if (!String(config.tripTitle || "").trim()) {
    throw new Error("TRIP_CONFIG.tripTitle is required.");
  }
  if (config.mode === "googleSheets" && !String(config.spreadsheetId || "").trim()) {
    throw new Error("TRIP_CONFIG.spreadsheetId is required when mode is googleSheets.");
  }
  if (config.mode === "appsScript" && !String(config.appsScriptUrl || "").trim()) {
    throw new Error("TRIP_CONFIG.appsScriptUrl is required when mode is appsScript.");
  }
  console.log(`OK docs/trip-config.js (${config.mode})`);
}

function checkInlineScripts(relativePath) {
  const html = read(relativePath);
  const scripts = [...html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);

  scripts.forEach((script, index) => {
    try {
      new Function(script);
    } catch (error) {
      throw new Error(`${relativePath} inline script ${index + 1} failed: ${error.message}`);
    }
  });
  console.log(`OK ${relativePath} (${scripts.length} inline script(s))`);
}

checkScript("docs/trip-config.js");
checkScript("docs/sw.js");
checkJson("docs/site.webmanifest");
checkJson("docs/expense-entry.webmanifest");
loadTripConfig();
checkInlineScripts("docs/index.html");
checkInlineScripts("docs/expense-entry.html");
checkInlineScripts("docs/itinerary-editor.html");
