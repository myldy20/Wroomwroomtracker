import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const liveUrl = process.env.LIVE_URL;
const expectedBuild = process.env.EXPECTED_BUILD;
const chromeBin = process.env.CHROME_BIN;

if (!liveUrl) throw new Error("LIVE_URL is required");
if (!expectedBuild) throw new Error("EXPECTED_BUILD is required");
if (!chromeBin) throw new Error("CHROME_BIN is required");

const outDir = path.resolve("artifacts/live-pages-smoke");
fs.mkdirSync(outDir, { recursive: true });

const consoleLines = [];
const pageErrors = [];
const requestFailures = [];
const badResponses = [];

const browser = await chromium.launch({
  executablePath: chromeBin,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();

page.on("console", (message) => {
  consoleLines.push(`[${message.type()}] ${message.text()}`);
});
page.on("pageerror", (error) => {
  pageErrors.push(error?.stack || String(error));
});
page.on("requestfailed", (request) => {
  requestFailures.push({
    url: request.url(),
    failure: request.failure()?.errorText || "unknown",
  });
});
page.on("response", (response) => {
  if (response.status() >= 400) {
    badResponses.push({ status: response.status(), url: response.url() });
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const buildUrl = new URL(liveUrl);
buildUrl.searchParams.set("e2e", expectedBuild);

let liveBuild = null;
for (let attempt = 1; attempt <= 8; attempt++) {
  await page.goto(buildUrl.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector("#startButton", { state: "visible", timeout: 15_000 });
  liveBuild = await page.evaluate(() => window.WROOM_BUILD || null);
  if (liveBuild === expectedBuild) break;
  console.log(`Deploy not fresh yet: expected ${expectedBuild}, saw ${liveBuild}; retry ${attempt}/8`);
  await sleep(5_000);
}

if (liveBuild !== expectedBuild) {
  throw new Error(`Live Pages build is stale: expected ${expectedBuild}, saw ${liveBuild}`);
}

console.log(`Live build verified: ${liveBuild}`);

// The interaction regression tests the tracker itself, not the first-run help.
// Suppress onboarding before START so its delayed modal cannot intercept PLAY/STOP.
await page.evaluate(() => localStorage.setItem("wroomwroom-web-seen", "1"));

const before = await page.locator("#startButton").innerText();
if (!/START TRACKER|RETRY/.test(before)) {
  throw new Error(`Unexpected initial START label: ${before}`);
}

await page.locator("#startButton").click();

await page.waitForFunction(() => {
  const button = document.querySelector("#startButton");
  return button && button.textContent !== "START TRACKER";
}, null, { timeout: 3_000 });

console.log("START reacted:", await page.locator("#startButton").innerText());

let success = false;
let failure = null;
try {
  await page.waitForFunction(() => {
    const overlay = document.querySelector("#startOverlay");
    const songGrid = document.querySelector("#songGrid");
    const semantic = document.querySelector("#semanticWorkspace");
    if (!overlay || !songGrid || !semantic) return false;

    const overlayHidden =
      overlay.hidden ||
      overlay.style.display === "none" ||
      getComputedStyle(overlay).display === "none";

    const semanticVisible =
      !semantic.hidden &&
      getComputedStyle(semantic).display !== "none";

    return overlayHidden && semanticVisible && songGrid.querySelectorAll(".song-cell").length > 0;
  }, null, { timeout: 180_000 });
  success = true;
} catch (error) {
  failure = error;
}

let interaction = null;
if (success) {
  const firstCell = page.locator('.song-cell[data-song-row="0"][data-song-track="0"]');
  await firstCell.click();
  const exactSelected = await firstCell.evaluate((cell) => cell.classList.contains("selected"));
  if (!exactSelected) throw new Error("Song selection did not land on row 0 / track 0");

  await page.locator("#songInspectorChooseChain").click();
  await page.waitForSelector("#chainPickerDialog[open]", { timeout: 5_000 });
  const pickerItems = page.locator("#chainPickerList .chain-picker-item");
  const pickerCount = await pickerItems.count();
  if (!pickerCount) throw new Error("Chain picker rendered no choices");
  const previews = page.locator("#chainPickerList .chain-picker-preview");
  if (!(await previews.count())) throw new Error("Chain picker shows no canonical Phrase previews");
  const firstPreview = await previews.first().innerText();
  if (!/P[0-9A-F]{3}/.test(firstPreview) || !/\d+ notes?/.test(firstPreview)) {
    throw new Error("Chain picker preview is missing actual Phrase IDs or note-event count: " + firstPreview);
  }
  const emptySlot = page.locator('#chainPickerList .chain-picker-item[data-chain-value="254"]');
  if (await emptySlot.count()) {
    const isBlank = await emptySlot.locator(".chain-picker-details").innerText();
    if (/empty slot/i.test(isBlank)) throw new Error("Default picker is cluttered by empty unused slots");
  }
  const preferred = page.locator("#chainPickerList .chain-picker-item.has-notes").first();
  if (await preferred.count()) await preferred.click();
  else await pickerItems.first().click();

  const assignedValue = await firstCell.locator(".song-cell-value").innerText();
  if (assignedValue === "—") throw new Error("Chain picker did not assign the selected Song cell");
  const selectedPreview = await page.locator("#inspectorBody .song-chain-preview").innerText();
  if (!/P[0-9A-F]{3}/.test(selectedPreview)) {
    throw new Error("Selected Song cell does not show actual Chain contents: " + selectedPreview);
  }

  const monitorCount = await page.evaluate(() => window.Module.ccall("webSongTrackCount", "number"));
  if ((await page.locator("#songActivityRows .track-activity-row").count()) !== monitorCount)
    throw new Error("Semantic Song dropped native track activity for a track");
  const glyph = await page.evaluate(() => window.Module.ccall(
    "webTrackActivityGlyph", "string", ["number"], [0]));
  const gw = Number.parseInt(glyph.slice(0, 2), 16);
  const gh = Number.parseInt(glyph.slice(2, 4), 16);
  if (!gw || !gh || glyph.length !== 4 + gw * gh)
    throw new Error("Native track waveform pixel bitmap is missing/invalid");
  if ((await page.locator("#songActivityRows .track-activity-wave").count()) !== monitorCount)
    throw new Error("Track waveform canvas missing");
  const scopeHex = await page.evaluate(() => window.Module.ccall(
    "webTrackAudioScopeHex", "string", ["number"], [0]));
  if (!/^[0-9A-F]{1024}$/.test(scopeHex))
    throw new Error("Native 256-sample signed 16-bit audio scope bridge missing or invalid");
  await page.waitForFunction(() =>
    document.querySelector("#songActivityRows .track-activity-wave")?.width > 8,
    null, {timeout: 5_000});
  const scopeSize = await page.locator("#songActivityRows .track-activity-wave").first()
    .evaluate(node => ({width: node.width, height: node.height}));
  if (scopeSize.width < 24 || scopeSize.height < 28)
    throw new Error("Track monitor is too small for a readable waveform: " +
      JSON.stringify(scopeSize));

  // Use a controlled bridge response to verify the renderer, leaving native
  // audio untouched. Identical 2-millipercent and 70%-level sine shapes must
  // fill similar vertical space; true silence must stay flat.
  await page.evaluate(() => {
    window.__scopeOriginalCcall = window.Module.ccall;
    window.__scopeInjectedHex = null;
    window.Module.ccall = function(name, ...args) {
      if (name === "webTrackAudioScopeHex" && args[2]?.[0] === 0 &&
          window.__scopeInjectedHex !== null) return window.__scopeInjectedHex;
      return window.__scopeOriginalCcall.call(this, name, ...args);
    };
  });
  const probeScopeSpan = async (amplitude) => {
    await page.evaluate(level => {
      window.__scopeInjectedHex = Array.from({length: 256}, (_, i) => {
        const sample = Math.round(Math.sin(i * Math.PI * 8 / 256) * level * 32767);
        return (sample & 65535).toString(16).toUpperCase().padStart(4, "0");
      }).join("");
    }, amplitude);
    await page.waitForTimeout(160);
    return page.locator("#songActivityRows .track-activity-wave").first().evaluate(canvas => {
      const {width, height} = canvas;
      const data = canvas.getContext("2d").getImageData(0, 0, width, height).data;
      let top = height, bottom = -1;
      for (let y = 0; y < height; ++y) {
        for (let x = 0; x < width; ++x) {
          const i = (y * width + x) * 4;
          // Count opaque cyan signal pixels, not the faint reference baseline.
          if (data[i + 3] > 128 && data[i] > 65 && data[i + 1] > 150) {
            top = Math.min(top, y); bottom = Math.max(bottom, y);
          }
        }
      }
      return {span: bottom < top ? 0 : bottom - top + 1, height};
    });
  };
  const quiet = await probeScopeSpan(0.002);
  const loud = await probeScopeSpan(0.7);
  const silent = await probeScopeSpan(0);
  await page.evaluate(() => {
    window.Module.ccall = window.__scopeOriginalCcall;
    delete window.__scopeOriginalCcall;
    delete window.__scopeInjectedHex;
  });
  if (quiet.span < quiet.height * 0.45 || loud.span < loud.height * 0.45 ||
      Math.abs(quiet.span - loud.span) > loud.height * 0.25)
    throw new Error("Auto-gain failed for quiet/loud waveforms: " +
      JSON.stringify({quiet, loud}));
  if (silent.span > 2)
    throw new Error("Silence was amplified into a false waveform: " +
      JSON.stringify(silent));

  const piano = page.locator("#songActivityPiano");
  if ((await piano.locator(".monitor-key").count()) !== 12) {
    throw new Error("Global monitor must show seven white and five black keys");
  }
  const nativePiano = await page.evaluate(() => window.Module.ccall("webMonitorPianoNotes", "number"));
  const shownPiano = await piano.getAttribute("data-active-mask");
  if (nativePiano !== Number(shownPiano)) {
    throw new Error("Piano must display the engine's exact chord-aware pitch mask");
  }
  if (monitorCount >= 2) {
    const firstMute = page.locator('#songActivityRows [data-track="0"] .track-mute');
    const secondSolo = page.locator('#songActivityRows [data-track="1"] .track-solo');
    await firstMute.click();
    const afterMute = await page.evaluate(() => window.Module.ccall(
      "webTrackActivityPacked", "number", ["number"], [0]));
    if (((afterMute >> 8) & 3) !== 2 || (await firstMute.getAttribute("aria-pressed")) !== "true")
      throw new Error("MUTE control failed to use native track state");
    await secondSolo.click();
    const afterSolo = await page.evaluate(() => [
      window.Module.ccall("webTrackActivityPacked", "number", ["number"], [0]),
      window.Module.ccall("webTrackActivityPacked", "number", ["number"], [1]),
    ]);
    if (((afterSolo[0] >> 8) & 3) === 2 || ((afterSolo[1] >> 8) & 3) !== 1)
      throw new Error("SOLO did not clear existing MUTE using native audio manager");
    await secondSolo.click();
    const restored = await page.evaluate(() => window.Module.ccall(
      "webTrackActivityPacked", "number", ["number"], [1]));
    if (((restored >> 8) & 3) !== 0) throw new Error("SOLO could not be reset");
  }
  const noQueued = await page.evaluate(() => window.Module.ccall(
    "webSongLiveQueuePacked", "number", ["number"], [0]));
  if (noQueued !== 0) throw new Error("Native live queue should start empty");

  // Track monitor must survive leaving semantic Song, without a second JS audio model.
  await page.locator('.view-tabs [data-screen="1"]').click();
  await page.waitForFunction(() => document.querySelector("#screenName")?.textContent === "CHAIN",
    null, {timeout: 5_000});
  if (!(await page.locator("#songActivityPanel").isVisible()))
    throw new Error("Global track monitor disappeared on CHAIN");
  if ((await page.locator("#songActivityPiano .monitor-key").count()) !== 12)
    throw new Error("Global piano disappeared on CHAIN");
  await page.locator('.view-tabs [data-screen="0"]').click();
  await page.waitForSelector("#songGrid .song-cell", {timeout: 5_000});

  const stereoMeters = page.locator("#masterMeter [role=meter]");
  if ((await stereoMeters.count()) !== 2) throw new Error("Two global master meters are required");
  await page.locator("#playToggle").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".song-cell.playing").length > 0,
    null,
    { timeout: 12_000 },
  );

  const farCell = page.locator('.song-cell[data-song-row="31"][data-song-track="0"]');
  await farCell.click();
  await page.waitForFunction(() => {
    const selected = document.querySelector(".song-cell.selected");
    const playing = [...document.querySelectorAll(".song-cell.playing")];
    return selected?.dataset.songRow === "31" &&
      playing.length > 0 &&
      !selected.classList.contains("playing");
  }, null, { timeout: 5_000 });

  const playingBeforeStop = await page.locator(".song-cell.playing").count();
  await page.waitForFunction(() =>
    [...document.querySelectorAll("#masterMeter [role=meter]")].every(
      element => element.hasAttribute("aria-valuetext") &&
        /dBFS peak/.test(element.getAttribute("aria-valuetext"))
    ), null, { timeout: 5_000 });
  const levels = await page.evaluate(() => window.Module.ccall("webOutputStereoPeaksPacked", "number"));
  if (!Number.isInteger(levels) || levels < 0 || levels > 0xffffff)
    throw new Error("Stereo telemetry bridge returned invalid packed peaks");
  await page.locator("#stopButton").click();
  await page.waitForFunction(
    () => document.querySelectorAll(".song-cell.playing").length === 0,
    null,
    { timeout: 5_000 },
  );

  const rowsBefore = await page.locator(".song-grid-row").count();
  let rowsAfter = rowsBefore;
  if (await page.locator("#songMoreRows").isVisible()) {
    await page.locator("#songMoreRows").click();
    rowsAfter = await page.locator(".song-grid-row").count();
    if (rowsAfter <= rowsBefore) throw new Error("Show more Song rows did not extend the arrangement");

    const extendedCell = page.locator('.song-cell[data-song-row="' + rowsBefore + '"][data-song-track="0"]');
    await extendedCell.click();
    if (!(await extendedCell.evaluate((cell) => cell.classList.contains("selected")))) {
      throw new Error("Extended Song rows are not directly selectable");
    }

    await page.locator("#songEditSelected").click();
    await page.waitForSelector("#songCellDialog[open]", { timeout: 5_000 });
    await page.locator("#songCellDialogClose").click();

    const lastVisibleRow = rowsAfter - 1;
    const bottomCell = page.locator('.song-cell[data-song-row="' + lastVisibleRow + '"][data-song-track="0"]');
    await bottomCell.focus();
    if (rowsAfter < 256) {
      await bottomCell.press("ArrowDown");
      const nextRow = page.locator('.song-cell[data-song-row="' + rowsAfter + '"][data-song-track="0"]');
      if (!(await nextRow.count()) || !(await nextRow.evaluate((cell) => cell.classList.contains("selected")))) {
        throw new Error("Keyboard navigation failed to reveal the next Song row");
      }
    }
  }

  interaction = {
    rowsBefore,
    rowsAfter,
    exactSelected,
    pickerCount,
    assignedValue,
    playingBeforeStop,
    selectedRowAfterPlaybackMove: await page.locator(".song-cell.selected").getAttribute("data-song-row"),
  };
}

const diagnostics = await page.evaluate(() => {
  const overlay = document.querySelector("#startOverlay");
  const semantic = document.querySelector("#semanticWorkspace");
  const songGrid = document.querySelector("#songGrid");
  const start = document.querySelector("#startButton");
  const status = document.querySelector("#status");

  return {
    title: document.title,
    build: window.WROOM_BUILD || null,
    href: location.href,
    startText: start?.textContent || null,
    startDisabled: !!start?.disabled,
    statusText: status?.textContent || null,
    startupStageFunction: typeof window.wroomStartupStage,
    runtimeReadyFunction: typeof window.wroomRuntimeReady,
    startFunction: typeof window.wroomStartTracker,
    overlayHidden: !!overlay?.hidden,
    overlayInlineDisplay: overlay?.style?.display || "",
    overlayComputedDisplay: overlay ? getComputedStyle(overlay).display : null,
    semanticHidden: !!semantic?.hidden,
    semanticComputedDisplay: semantic ? getComputedStyle(semantic).display : null,
    songCellCount: songGrid?.querySelectorAll(".song-cell").length || 0,
    modulePresent: !!window.Module,
    moduleCalledRun: window.Module?.calledRun ?? null,
    moduleRuntimeInitialized: window.Module?.runtimeInitialized ?? null,
  };
});

const report = {
  success,
  expectedBuild,
  diagnostics,
  interaction,
  pageErrors,
  requestFailures,
  badResponses,
  console: consoleLines,
};

fs.writeFileSync(
  path.join(outDir, "report.json"),
  JSON.stringify(report, null, 2),
);
await page.screenshot({
  path: path.join(outDir, success ? "success.png" : "failure.png"),
  fullPage: true,
});

console.log(JSON.stringify(report, null, 2));

await browser.close();

if (!success) {
  throw new Error(
    `Live startup did not reach visible Song workspace. Last state: ${JSON.stringify(diagnostics)}\n${failure || ""}`,
  );
}
