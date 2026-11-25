import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = createRequire(resolve("package.json"))("playwright");
const { APP_URL = "http://127.0.0.1:4173", VARIANT, SCENARIO = "settled", OUTPUT_DIR = "ui-recordings" } = process.env;
assert(["before", "after"].includes(VARIANT), "VARIANT must be before or after");
assert(["settled", "inflight"].includes(SCENARIO), "SCENARIO must be settled or inflight");
const inflight = SCENARIO === "inflight";
const stem = "2192-" + VARIANT + (inflight ? "-inflight" : "");
let releaseMark;
const heldMark = new Promise(resolve => { releaseMark = resolve; });
const origin = new URL(APP_URL).origin;
assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(APP_URL).hostname), "Use a local app only");
const dir = resolve(OUTPUT_DIR);
await mkdir(dir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, recordVideo: { dir, size: { width: 1280, height: 800 } }, serviceWorkers: "block" });
const page = await context.newPage();
const video = page.video();
page.setDefaultTimeout(8000);
const marketText = "Demo market resolved";
const followText = "Demo reader followed you";
let mode = "game", auth = 0, lists = 0, mark = 0;
const serverItems = [
  { id: "social-demo", kind: "follow", title: followText, isRead: false, isGameOnly: false, timestamp: "Just now" },
  { id: "game-demo", kind: "market_resolved", title: marketText, isRead: false, isGameOnly: true, timestamp: "Just now" },
];
try {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const send = (json) => route.fulfill({ json });
    if (url.pathname === "/api/auth/me") {
      auth++;
      return send({ authenticated: true, publicAppUrl: origin, viewer: { accountId: "video-demo", handle: "video-demo", displayName: "Demo Viewer", ui_mode: mode, balanceCents: 10000 } });
    }
    const visible = mode === "game" ? serverItems : serverItems.filter(x => !x.isGameOnly);
    if (url.pathname === "/api/notifications" && route.request().method() === "GET") {
      lists++;
      return send({ notifications: visible, unreadCount: visible.filter(x => !x.isRead).length });
    }
    if (url.pathname === "/api/notifications/read" && route.request().method() === "POST") {
      assert.equal(mode, "social");
      assert.deepEqual(route.request().postDataJSON(), {});
      mark++;
      let markedCount = 0;
      for (const item of visible) if (!item.isRead) { item.isRead = true; markedCount++; }
      const result = { markedCount, unreadCount: visible.filter(x => !x.isRead).length };
      if (inflight) await heldMark;
      return send(result);
    }
    return send({});
  });
  await page.addInitScript(() => {
    let realtimeSource = null;
    class DemoEventSource extends EventTarget {
      constructor(url) {
        super();
        if (String(url).endsWith("/api/events")) realtimeSource = this;
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
      close() { if (realtimeSource === this) realtimeSource = null; }
    }
    globalThis.EventSource = DemoEventSource;
    globalThis.feedVideoEmitMarketSpot = () => {
      if (!realtimeSource) throw new Error("App has no active /api/events subscriber");
      realtimeSource.dispatchEvent(new MessageEvent("market.spot", { data: "{}" }));
    };
  });
  async function caption(message) {
    await page.evaluate(({ label, message }) => {
      let box = document.getElementById("feed-video-caption");
      if (!box) {
        box = document.createElement("div");
        box.id = "feed-video-caption";
        box.setAttribute("style", "position:fixed;z-index:2147483647;left:20px;bottom:20px;max-width:930px;border:2px solid #79dcff;border-radius:8px;padding:13px 18px;background:#15243b;color:white;font:600 18px system-ui;pointer-events:none");
        document.body.append(box);
      }
      box.textContent = label + " • " + message;
    }, { label: VARIANT.toUpperCase() + " | SYNTHETIC DATA", message });
    await page.waitForTimeout(1050);
  }
  async function externalMode(next) {
    mode = next;
    const response = page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/me");
    await page.evaluate(() => globalThis.feedVideoEmitMarketSpot());
    await response;
  }
  await page.goto(new URL("/notifications", APP_URL).href, { waitUntil: "domcontentloaded" });
  const market = page.getByText(marketText, { exact: true });
  const follow = page.getByText(followText, { exact: true });
  const markAll = page.getByRole("button", { name: "Mark all read", exact: true });
  const marketsTab = page.getByRole("tab", { name: "Markets", exact: true });
  await market.waitFor({ state: "visible" });
  await follow.waitFor({ state: "visible" });
  await marketsTab.waitFor({ state: "visible" });
  assert.equal(await markAll.isEnabled(), true);
  const initialLists = lists;
  assert.ok(initialLists >= 1);
  const initialAuth = auth;
  await caption("Game mode: both notifications are initially unread.");
  await externalMode("social");
  await market.waitFor({ state: "hidden" });
  await marketsTab.waitFor({ state: "hidden" });
  await follow.waitFor({ state: "visible" });
  assert.equal(lists, initialLists, "No list refetch on external mode change");
  await caption("External mode change via auth refresh: the market notification is hidden.");
  const markResponse = page.waitForResponse(r => new URL(r.url()).pathname === "/api/notifications/read");
  await markAll.click();
  if (inflight) {
    for (let i = 0; mark === 0 && i < 80; i++) await page.waitForTimeout(100);
    assert.equal(mark, 1, "Social-mode POST reached synthetic server before external mode changed");
    await caption("Clicked Mark all read in Social mode; its response is held.");
    await externalMode("game");
    await market.waitFor({ state: "visible" });
    await marketsTab.waitFor({ state: "visible" });
    assert.equal(lists, initialLists, "External mode change itself did not reread notifications");
    const canonicalResponse = VARIANT === "after" ? page.waitForResponse(r => new URL(r.url()).pathname === "/api/notifications") : null;
    releaseMark();
    await markResponse;
    if (canonicalResponse) await canonicalResponse;
  } else {
    await markResponse;
    await markAll.locator("xpath=self::*[@disabled]").waitFor({ state: "visible" });
    await caption("Clicked Mark all read in Social mode. Only the follow is read on the server.");
    await externalMode("game");
    await market.waitFor({ state: "visible" });
    await marketsTab.waitFor({ state: "visible" });
  }
  const expectedEnabled = VARIANT === "after";
  await markAll.locator(expectedEnabled ? "xpath=self::*[not(@disabled)]" : "xpath=self::*[@disabled]").waitFor({ state: "visible" });
  assert.equal(mark, 1);
  assert.equal(serverItems.find(x => x.id === "game-demo").isRead, false);
  assert.equal(lists, initialLists + (inflight && expectedEnabled ? 1 : 0), "Only the fixed in-flight path canonical-reloads the list");
  assert.equal(auth, initialAuth + 2);
  const actionEnabled = await markAll.isEnabled();
  assert.equal(actionEnabled, VARIANT === "after", "Only fixed Game-mode UI still has an unread visible item");
  await caption(actionEnabled ? "Game mode again: market remains unread; Mark all read is enabled." : "Game mode again: market is incorrectly shown as read; Mark all read is disabled.");
  await page.screenshot({ path: resolve(dir, stem + "-final.png") });
  await writeFile(resolve(dir, stem + ".json"), JSON.stringify({ variant: VARIANT, scenario: SCENARIO, notificationsGET: lists, authRefreshes: auth - initialAuth, readPOST: mark, serverMarketUnread: true, finalMarkAllEnabled: actionEnabled }, null, 2) + "\n");
} catch (e) {
  await page.screenshot({ path: resolve(dir, stem + "-failure.png") }).catch(() => {});
  console.error("2192 recording failed", { mode, auth, lists, mark, pageUrl: page.url() });
  throw e;
} finally {
  releaseMark();
  await context.close();
  await video?.saveAs(resolve(dir, stem + ".webm"));
  await video?.delete();
  await browser.close();
}
