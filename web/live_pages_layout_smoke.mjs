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
  { name: "mobile-360x780", width: 360, height: 780, desktop: false },
  { name: "mobile-320x680", width: 320, height: 680, desktop: false },
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
        masterMeter: rect("#masterMeter"),
        brand: rect(".brand"),
        playButton: rect("#playToggle"),
        utilityMenu: rect("#mobileMenuButton"),
        firstUtility: rect(".utility-drawer"),
        songScroll: rect("#songScroll"),
        songEdit: rect("#songEditSelected"),
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
    assert.ok(metrics.masterMeter?.width >= (viewport.width <= 380 ? 40 : 48) &&
      metrics.masterMeter.right <= viewport.width,
      viewport.name + ": global stereo meter must remain visible in the top bar");
    assert.ok(metrics.brand?.right <= metrics.masterMeter?.x + 1,
      viewport.name + ": brand text must not collide with master meter");
    assert.ok(metrics.masterMeter?.right <= metrics.playButton?.x + 1,
      viewport.name + ": stereo meter must not collide with transport");
    assert.ok(metrics.utilityMenu?.right <= viewport.width,
      viewport.name + ": menu button must remain on-screen");
    assert.ok(metrics.songEdit?.height >= 44,
      viewport.name + ": direct Song EDIT action must remain a 44px touch target");

    if (!viewport.desktop) {
      const monitor = page.locator("#songActivityMobile");
      assert.ok(await monitor.isVisible(), viewport.name + ": mobile native track monitor missing");
      assert.ok(!(await monitor.evaluate(el => el.open)),
        viewport.name + ": activity expander must start closed");
      await monitor.locator("summary").click();
      assert.ok(await monitor.evaluate(el => el.open),
        viewport.name + ": native track monitor cannot be opened");
      assert.ok(await page.locator("#songActivityMobileRows .track-activity-row").count() > 0,
        viewport.name + ": expanded track activity has no tracks");
      assert.equal(await page.locator("#songActivityMobilePiano .monitor-key").count(), 12,
        viewport.name + ": global mobile piano must keep all twelve keys");
      await monitor.locator("summary").click();
    }

    if (viewport.desktop) {
      assert.ok(await page.locator("#songActivityPanel").isVisible(),
        viewport.name + ": native right-hand track status missing from Song");
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

    if (!viewport.desktop) {
      // Exercise the visible touch-first editor without using a double tap,
      // keyboard shortcut or the desktop-only inspector.
      await page.locator("#songEditSelected").click();
      await page.waitForSelector("#songCellDialog[open]", { timeout: 5_000 });
      await page.locator("#songCellDialogClose").click();
    }

    // Global monitor is visible even on legacy CHAIN; mobile expander remains
    // reachable without switching back to SONG.
    await page.locator('.view-tabs [data-screen="1"]').click();
    await page.waitForFunction(() => document.querySelector("#screenName")?.textContent === "CHAIN",
      null, { timeout: 5_000 });
    if (viewport.desktop) {
      assert.ok(await page.locator("#songActivityPanel").isVisible(),
        viewport.name + ": global desktop monitor disappeared on CHAIN");
      assert.equal(await page.locator("#songActivityPiano .monitor-key").count(), 12);
    } else {
      assert.ok(await page.locator("#songActivityMobile").isVisible(),
        viewport.name + ": global mobile monitor disappeared on CHAIN");
    }
    await page.locator('.view-tabs [data-screen="0"]').click();

    // The migrated MIX must be directly usable at desktop and narrow phone sizes.
    // Native screen setup is queued until the next draw; simulate one stale
    // status response on tablet to ensure polling cannot undo a new tab choice.
    const staleNativeStatus = viewport.name.startsWith("tablet-");
    if (staleNativeStatus) await page.evaluate(() => {
      const real = window.Module.ccall;
      window.__mixLayoutRealCCall = real;
      window.Module.ccall = function (name, ...args) {
        return name === "webCurrentScreen" ? 0 : real.call(this, name, ...args);
      };
    });
    await page.locator('.view-tabs [data-screen="4"]').click();
    if (staleNativeStatus) {
      await page.waitForTimeout(1350); // crosses 1200ms periodic UI-state polling
      const stayedInMix = await page.locator("#mixWorkspace").isVisible();
      await page.evaluate(() => {
        window.Module.ccall = window.__mixLayoutRealCCall;
        delete window.__mixLayoutRealCCall;
      });
      assert.ok(stayedInMix, viewport.name + ": stale native screen status reversed direct MIX navigation");
    }
    await page.waitForFunction(() =>
      window.Module.ccall("webCurrentScreen", "number") === 4,
      null, {timeout: 10_000});
    await page.waitForSelector("#mixWorkspace:not([hidden]) .mix-pan-slider", {timeout: 6_000});
    const mixGeometry = await page.evaluate(() => {
      const parent = document.querySelector("#mixWorkspace");
      const slider = document.querySelector(".mix-pan-slider");
      const volume = document.querySelector(".mix-volume-slider");
      const reset = document.querySelector(".mix-pan-center");
      const bounds = slider?.getBoundingClientRect();
      const volumeBounds = volume?.getBoundingClientRect();
      const button = reset?.getBoundingClientRect();
      return {
        pageOverflow: document.documentElement.scrollWidth - innerWidth,
        parentWidth: parent?.clientWidth,
        parentScrollWidth: parent?.scrollWidth,
        sliderWidth: bounds?.width,
        volumeWidth: volumeBounds?.width,
        resetHeight: button?.height,
      };
    });
    assert.ok(mixGeometry.pageOverflow <= 1, viewport.name + ": MIX causes page overflow");
    assert.ok(mixGeometry.parentScrollWidth <= mixGeometry.parentWidth + 1,
      viewport.name + ": PAN controls overflow workspace");
    assert.ok(mixGeometry.sliderWidth >= 55 && mixGeometry.volumeWidth >= 55,
      viewport.name + ": MIX sliders unusably small: " + JSON.stringify(mixGeometry));
    assert.ok(mixGeometry.resetHeight >= 44, viewport.name + ": PAN center is not a touch target");
    await page.locator('.view-tabs [data-screen="0"]').click();

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
