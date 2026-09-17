import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const dist = resolve(process.cwd(), "dist");
const swPath = resolve(dist, "sw.js");
const identityFiles = ["asset-manifest.json", "trip-config.js", "deployment.json"];
const parts = [];
for (const file of identityFiles) {
  try { parts.push(await readFile(resolve(dist, file))); } catch { /* optional deployment identity */ }
}
const version = createHash("sha256").update(Buffer.concat(parts)).digest("hex").slice(0, 12);
const source = await readFile(swPath, "utf8");
if (!source.includes("__CACHE_VERSION__")) throw new Error("sw.js cache version placeholder is missing");
await writeFile(swPath, source.replaceAll("__CACHE_VERSION__", version));
console.log(`Finalized service worker cache: ${version}`);
