// Guard against accidentally removing the native behavior while migrating screens.
import fs from "node:fs";
import assert from "node:assert/strict";

const inventory = JSON.parse(fs.readFileSync("web/native_parity_inventory.json", "utf8"));
const shell = fs.readFileSync("web/wroom.js", "utf8");
const html = fs.readFileSync("web/index.html", "utf8");
const app = fs.readFileSync("tracker/src/app.cpp", "utf8");
assert.equal(inventory.screens.song, "semantic-incomplete");
assert.match(shell, /const semantic = screen === 0 \|\| \(screen === 1 && !nativeChainExpanded\) \|\|/,
  "Direct Chain must coexist with native fallback");
assert.match(shell, /screen === 2 && !nativePhraseExpanded/,
  "Direct Phrase must coexist with native fallback");
for (const id of ["chainWorkspace","phraseWorkspace","chainOpenNative","phraseOpenNative",
                  "chainReturnDirect","phraseReturnDirect"]) {
  assert.ok(html.includes('id="' + id + '"'), "Native fallback/direct pattern missing: " + id);
}
assert.match(shell, /webPhraseSetCell/, "Direct Phrase must use native Project bridge");
assert.match(shell, /webChainSelectedStep/, "Direct Chain cursor must follow native selection");
assert.match(shell, /activeUiScreen === 1 && !nativeChainExpanded\) renderChainWorkspace\(\)/,
  "Loading a project must refresh the visible Chain editor");
assert.match(shell, /activeUiScreen === 2 && !nativePhraseExpanded\) renderPhraseWorkspace\(\)/,
  "Loading a project must refresh the visible Phrase editor");
assert.match(html, /id="soundOpenNative"/, "SOUND must retain its full native editor");
assert.match(html, /id="soundReturnDirect"/, "Native preset dialogs must remain accessible");
assert.match(html, /id="soundPresetInput"/, "USER preset file import must be exposed");
assert.match(html, /id="soundPresetLibrary"/, "SOUND needs an in-page native USER catalog");
assert.match(html, /id="soundCreateControls"/, "Empty SOUND slots need direct engine creation");
assert.match(shell, /webSoundCreateInstrument/, "Engine creation must use native initializer");
assert.match(shell, /webSoundPresetsOpen/, "USER LOAD action must invoke the native parser");
assert.match(app, /webSoundSaveUserPreset/, "Native .cni saving must not be duplicated in JS");
assert.match(app, /userPresetFolder\(/, "Web library must reuse native engine type mapping");
assert.match(app, /webSoundPresetsError/, "Invalid USER programs must expose native error details");
assert.match(html, /id="mixOpenNative"/, "MIX must preserve the complete native mixer");
assert.match(html, /id="mixReturnDirect"/, "MIX must allow returning to direct PAN");
assert.match(shell, /\$\$\("\.view-tabs \[data-screen\], \.utility-buttons \[data-screen\]"\)\.forEach/,
  "Workspace navigation must bind a list of tabs, not a single element");
assert.match(shell, /pendingNativeScreen === null && current >= 0/,
  "Web screen updates must not override a pending native navigation");
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
assert.ok(counts["fallback-missing"] >= 3, "The Song migration is not yet native-complete");
assert.ok(counts.legacy >= 10, "Native fallback inventory unexpectedly shrank");

// Full registry snapshots: a new, renamed or removed native screen/engine
// requires a conscious UX/parity review rather than being silently forgotten.
const nativeScreens = fs.readFileSync("tracker/src/screens/screens.h", "utf8").matchAll(/extern const AppScreen (screen\w+);/g);
const screenNames = [...nativeScreens].map(match => match[1]).sort();
assert.deepEqual(inventory.registeredScreens.map(item => item.symbol).sort(), screenNames,
  "Native AppScreen inventory changed: revisit migration coverage and update registry");

const instrumentHeader = fs.readFileSync("chipnomad_lib/project_instruments.h", "utf8");
const instrumentEnum = instrumentHeader.match(/enum class InstrumentType\s*:\s*uint8_t\s*\{([\s\S]*?)\};/);
assert.ok(instrumentEnum, "Native InstrumentType enum missing");
const instrumentNames = [...instrumentEnum[1].matchAll(/^\s*(\w+)\s*=\s*\d+/gm)]
  .map(match => match[1]).sort();
assert.deepEqual(inventory.registeredInstrumentTypes.map(item => item.symbol).sort(), instrumentNames,
  "Native instrument catalogue changed: revisit Web support and update registry");
assert.equal(inventory.registeredScreens.find(item => item.symbol === "screenSong").webStatus,
  "semantic-partial", "Song parity status cannot be silently promoted");
assert.ok(inventory.registeredScreens.every(item =>
  ["semantic-partial", "native-legacy"].includes(item.webStatus)));

console.log("Native feature guard passed", counts);
