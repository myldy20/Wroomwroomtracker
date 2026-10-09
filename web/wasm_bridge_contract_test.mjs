// Source/dist Emscripten function export parity.
// A green C++ build does not prove the *committed* JS/WASM is current.
import fs from "node:fs";
import assert from "node:assert/strict";

const native = fs.readFileSync("tracker/src/screens/screen_song.cpp", "utf8");
const generated = fs.readFileSync("web/dist/choochootracker.js", "utf8");
const wasm = fs.readFileSync("web/dist/choochootracker.wasm");
const required = ["webSongChainPreview", "webSongChainInstrumentSearch"]; 
const trackExports = ["webTrackActivityPacked", "webTrackActivityNote", "webTrackActivityGlyph", "webMonitorPianoNotes", "webTrackAudioScopeHex"];
for (const symbol of trackExports) {
  assert.ok(fs.readFileSync("tracker/src/app.cpp", "utf8").includes(symbol + "("),
    "Native track visual bridge missing: " + symbol);
  assert.ok(generated.includes(symbol),
    "Compiled Web runtime omits native track visual bridge: " + symbol);
}
for (const symbol of required) {
  assert.ok(native.includes('extern "C" EMSCRIPTEN_KEEPALIVE const char* ' + symbol + '('), "Native export marker missing: " + symbol);
  assert.ok(generated.includes(symbol),
    "Emscripten bundle omits " + symbol + "; rebuild and commit web/dist before merging");
}
for (const name of ["webSongToggleTrackMute", "webSongToggleTrackSolo", "webSongLiveQueuePacked"]) {
  assert.ok(native.includes(name + "("), "Native Song bridge missing: " + name);
  assert.ok(generated.includes(name), "Compiled Web runtime omits: " + name);
}
for (const name of ["webMixTrackPan", "webMixSetTrackPan",
                    "webMixTrackVolume", "webMixSetTrackVolume"]) {
  assert.ok(fs.readFileSync("tracker/src/app.cpp", "utf8").includes(name + "("),
    "Native mixer bridge missing: " + name);
  assert.ok(generated.includes(name),
    "Compiled Web mixer runtime omits: " + name);
}
const audio = fs.readFileSync("tracker/src/audio_manager.cpp", "utf8");
assert.ok(audio.includes('extern "C" EMSCRIPTEN_KEEPALIVE int webOutputStereoPeaksPacked('), "Stereo export removed from C++");
assert.ok(generated.includes("webOutputStereoPeaksPacked"), "Committed WASM loader must include stereo export");
assert.ok(wasm.length > 100000, "Compiled WebAssembly binary missing/truncated");
assert.match(fs.readFileSync("chipnomad_lib/audio_monitor.h", "utf8"), /AUDIO_MONITOR_SAMPLES = 256/, "PCM scope sample count changed; update Web decoder");
console.log("Checked-in Emscripten bridge contract passed");
