import fs from "node:fs";
import assert from "node:assert/strict";

const shell = fs.readFileSync("web/wroom.js", "utf8");
const html = fs.readFileSync("web/index.html", "utf8");
const css = fs.readFileSync("web/wroom.css", "utf8");
const app = fs.readFileSync("tracker/src/app.cpp", "utf8");
const song = fs.readFileSync("tracker/src/screens/screen_song.cpp", "utf8");

assert.match(app, /webPlaybackTrackPacked/, "Web must read a compact canonical playback snapshot");
assert.match(app, /chipnomadGetPlaybackStatus/, "Playback bridge must come from canonical PlaybackStatus");
assert.match(song, /webSongChainSummary/, "Song must expose semantic Chain summaries");
assert.match(song, /webSongFindFreeChain/, "Song picker must assign a genuinely free Chain");

assert.match(html, /id="chainPickerDialog"/, "Chain picker dialog must exist");
assert.match(html, /id="chainPickerSearch"/, "Chain picker must expose visible search");
assert.match(shell, /songInspectorChooseChain/, "Picker must be the primary inspector action");
assert.match(shell, /updateSongPlaybackVisuals/);
assert.match(shell, /webPlaybackTrackPacked/, "DOM playback state must use the compact bridge");
assert.match(shell, /\}, 50\);/, "Playback visuals must refresh on a bounded loop");
assert.doesNotMatch(shell, /song-cell-meta/, "Song cells must not repeat CHAIN\/EMPTY micro-labels");
assert.match(css, /\.song-cell\.playing/, "Playing cell must have a distinct semantic style");
assert.match(css, /\.song-grid-row\.playing-row/, "Playing row must have a distinct semantic style");
assert.match(css, /\.song-cell\.selected/, "Selection styling must remain independent");
assert.match(css, /\.chain-picker-item/, "Chain picker must have touch-sized semantic choices");

console.log("Song semantic Web contract passed");
