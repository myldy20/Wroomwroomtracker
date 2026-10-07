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
