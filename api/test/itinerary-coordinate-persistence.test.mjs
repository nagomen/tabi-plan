import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

test("都市間移動の両端座標を保存しbootstrapで返す", () => {
  const repository = read("src/plan-repo.ts");
  const bootstrap = read("src/bootstrap-repo.ts");
  assert.match(repository, /from_place, from_lat, from_lng/);
  assert.match(repository, /to_place, to_lat, to_lng/);
  assert.match(repository, /it\.from_lat \?\? null/);
  assert.match(repository, /it\.to_lat \?\? null/);
  assert.match(bootstrap, /from_place, from_lat, from_lng/);
  assert.match(bootstrap, /to_place, to_lat, to_lng/);
});

