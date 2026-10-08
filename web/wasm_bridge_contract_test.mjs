// Source/dist Emscripten function export parity.
// A green C++ build does not prove the *committed* JS/WASM is current.
import fs from "node:fs";
import assert from "node:assert/strict";

const native = fs.readFileSync("tracker/src/screens/screen_song.cpp", "utf8");
const generated = fs.readFileSync("web/dist/choochootracker.js", "utf8");
const wasm = fs.readFileSync("web/dist/choochootracker.wasm");
const required = ["webSongChainPreview", "webSongChainInstrumentSearch"];
for (const symbol of required) {
  assert.ok(native.includes('extern "C" EMSCRIPTEN_KEEPALIVE const char* ' + symbol + '('), "Native export marker missing: " + symbol);
  assert.ok(generated.includes(symbol),
    "Emscripten bundle omits " + symbol + "; rebuild and commit web/dist before merging");
}
assert.ok(wasm.length > 100000, "Compiled WebAssembly binary missing/truncated");
console.log("Checked-in Emscripten bridge contract passed");
