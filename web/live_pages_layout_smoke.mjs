import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";

const liveUrl = process.env.LIVE_URL;
const expectedBuild = process.env.EXPECTED_BUILD;
const chromeBin = process.env.CHROME_BIN;

if (!liveUrl) throw new Error("LIVE_URL is required");
if (!expectedBuild) throw new Error("EXPECTED_BUILD is required");
if (!chromeBin) throw new Error("CHROME_BIN is required");

const outDir = path.resolve("artifacts/live-pages-smoke");
fs.mkdirSync(outDir, { recursive: true });

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900, desktop: true },
  { name: "desktop-1280x800", width: 1280, height: 800, desktop: true },
  { name: "tablet-768x1024", width: 768, height: 1024, desktop: false },
  { name: "mobile-390x844", width: 390, height: 844, desktop: false },
];

const browser = await chromium.launch({
  executablePath: chromeBin,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

const reports = [];
try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
    });
    const page = await context.newPage();
    const target = new URL(liveUrl);
    target.searchParams.set("layout-e2e", expectedBuild);

    await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#startButton", { state: "visible", timeout: 15_000 });
    const liveBuild = await page.evaluate(() => window.WROOM_BUILD || null);
    assert.equal(liveBuild, expectedBuild, viewport.name + ": stale Pages build");

    await page.evaluate(() => localStorage.setItem("wroomwroom-web-seen", "1"));
    await page.locator("#startButton").click();
    await page.waitForFunction(() => {
      const overlay = document.querySelector("#startOverlay");
      const grid = document.querySelector("#songGrid");
      const semantic = document.querySelector("#semanticWorkspace");
      return overlay && semantic && grid &&
        (overlay.hidden || getComputedStyle(overlay).display === "none") &&
        !semantic.hidden &&
        grid.querySelectorAll(".song-cell").length > 0;
    }, null, { timeout: 180_000 });

    const metrics = await page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom, right: r.right };
      };
      const visible = (selector) => {
        const el = document.querySelector(selector);
        return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0;
      };
      const navTargets = [...document.querySelectorAll(".view-tabs button")].map((el) => {
        const r = el.getBoundingClientRect();
        return { width: r.width, height: r.height };
      });
      const utilityDrawers = [...document.querySelectorAll(".utility-drawer")];

      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentOverflow: document.documentElement.scrollWidth - innerWidth,
        workbenchVisible: visible(".workbench"),
        selection: rect("#selectionInspector"),
        firstUtility: rect(".utility-drawer"),
        songScroll: rect("#songScroll"),
        songScrollWidths: {
          client: document.querySelector("#songScroll")?.clientWidth || 0,
          scroll: document.querySelector("#songScroll")?.scrollWidth || 0,
        },
        navVisible: visible(".view-tabs"),
        navTargets,
        mobileMenuVisible: visible("#mobileMenuButton"),
        utilityOpenCount: utilityDrawers.filter((el) => el.open).length,
      };
    });

    assert.ok(metrics.documentOverflow <= 1, viewport.name + ": page itself must not horizontally overflow");
    assert.ok(metrics.navVisible, viewport.name + ": workspace navigation must stay visible");

    if (viewport.desktop) {
      assert.ok(metrics.workbenchVisible, viewport.name + ": context inspector must be visible");
      assert.ok(metrics.selection, viewport.name + ": selection inspector missing");
      assert.ok(metrics.firstUtility, viewport.name + ": compact project drawer missing");
      assert.ok(metrics.selection.y < metrics.firstUtility.y, viewport.name + ": inspector must lead utility tools");
      assert.equal(metrics.utilityOpenCount, 0, viewport.name + ": secondary project drawers must start collapsed");
      assert.ok(metrics.songScroll?.width >= 620, viewport.name + ": musical workspace is too narrow");
    } else {
      assert.ok(!metrics.workbenchVisible, viewport.name + ": desktop workbench must collapse on narrow screens");
      assert.ok(metrics.mobileMenuVisible, viewport.name + ": project/tools menu must remain reachable");
      assert.ok(metrics.navTargets.every((target) => target.height >= 44),
        viewport.name + ": bottom navigation touch targets must be at least 44px high");
      assert.ok(metrics.songScrollWidths.scroll >= metrics.songScrollWidths.client,
        viewport.name + ": Song horizontal scrolling contract is broken");
    }

    await page.screenshot({
      path: path.join(outDir, viewport.name + ".png"),
      fullPage: false,
    });
    reports.push({ ...viewport, metrics });
    await context.close();
  }
} finally {
  await browser.close();
}

fs.writeFileSync(
  path.join(outDir, "layout-report.json"),
  JSON.stringify({ expectedBuild, reports }, null, 2),
);
console.log("Responsive layout contracts passed:", reports.map((r) => r.name).join(", "));
