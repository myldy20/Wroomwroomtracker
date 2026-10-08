// Guard against accidentally removing the native behavior while migrating screens.
import fs from "node:fs";
import assert from "node:assert/strict";

const inventory = JSON.parse(fs.readFileSync("web/native_parity_inventory.json", "utf8"));
const shell = fs.readFileSync("web/wroom.js", "utf8");
const html = fs.readFileSync("web/index.html", "utf8");
assert.equal(inventory.screens.song, "semantic-incomplete");
assert.match(shell, /const semantic = screen === 0;/,
  "Do not silently treat unfinished screens as fully semantic");
assert.match(shell, /legacyWorkspace\.hidden = semantic;/,
  "Legacy fallback must remain available for unmigrated screens");
assert.match(html, /<canvas id="canvas"/, "Native canvas fallback must still exist");
const counts = {};
for (const entry of inventory.features) {
  assert.ok(inventory.screens[entry.screen], "Unknown screen: " + entry.screen);
  assert.ok(["semantic","legacy","fallback-missing"].includes(entry.status),
    "Unexpected status: " + entry.status);
  const source = fs.readFileSync(entry.native, "utf8");
  assert.ok(source.includes(entry.source),
    entry.label + ": native behavior marker disappeared; re-audit before accepting change");
  counts[entry.status] = (counts[entry.status] || 0) + 1;
  if (entry.status === "fallback-missing") assert.equal(entry.screen, "song");
}
assert.ok(counts["fallback-missing"] >= 5, "The Song migration is not yet native-complete");
assert.ok(counts.legacy >= 10, "Native fallback inventory unexpectedly shrank");
console.log("Native feature guard passed", counts);
