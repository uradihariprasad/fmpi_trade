import { chromium } from "playwright";
const url = process.env.TEST_URL ?? "http://127.0.0.1:3000";
const browser = await chromium.launch({ headless: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", e => { errors.push(String(e)); console.error("PAGEERROR", e.message); });

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForSelector("header", { timeout: 60000 });
const rail = page.locator("aside").filter({ has: page.getByRole("button", { name: "Expand panel to full screen" }) }).first();
await rail.waitFor({ state: "visible", timeout: 60000 });
await page.waitForTimeout(2000);

const vp = page.viewportSize();
const railBox = await rail.boundingBox();
console.log(`viewport ${vp.width}x${vp.height} | rail w=${Math.round(railBox.width)} (${Math.round(railBox.width/vp.width*100)}% of screen)`);

// open full-screen panel from the rail
await page.getByRole("button", { name: "Expand panel to full screen" }).first().click();
await page.waitForTimeout(400);
const overlay = page.locator("aside").filter({ has: page.getByRole("button", { name: "Close panel" }) });
const expandedBox = await overlay.boundingBox();
console.log(`expanded panel w=${Math.round(expandedBox.width)} h=${Math.round(expandedBox.height)} (${Math.round(expandedBox.width/vp.width*100)}% of screen width)`);
console.log("full screen:", expandedBox.width > vp.width * 0.85 && expandedBox.height > vp.height * 0.85 ? "YES" : "NO");

// switch tabs inside the overlay and check grid columns actually rendered
await page.getByRole("button", { name: /TOP 10/ }).last().click(); await page.waitForTimeout(250);
await page.getByRole("button", { name: /^ALL$/ }).last().click(); await page.waitForTimeout(250);
const grid = page.locator("div.grid").filter({ has: page.locator("button") }).first();
const gridBox = await grid.boundingBox();
console.log(`ALL grid w=${Math.round(gridBox.width)} → ${Math.round(gridBox.width/vp.width*100)}% of screen`);
await page.getByRole("button", { name: /TRADES/ }).last().click(); await page.waitForTimeout(250);

// ESC collapses
await page.keyboard.press("Escape"); await page.waitForTimeout(300);
console.log("ESC collapsed:", (await page.getByRole("button", { name: "Close panel" }).count()) === 0 ? "YES" : "NO");

// reopen and pick an instrument → should collapse and change symbol
await page.getByRole("button", { name: "Expand panel to full screen" }).first().click(); await page.waitForTimeout(300);
await page.getByRole("button", { name: /^ALL$/ }).last().click(); await page.waitForTimeout(200);
await page.getByRole("button", { name: /^SENSEX\s+FUT/ }).first().click(); await page.waitForTimeout(600);
console.log("pick collapsed panel:", (await page.getByRole("button", { name: "Close panel" }).count()) === 0 ? "YES" : "NO");
console.log("symbol switched to SENSEX:", (await page.locator("body").innerText()).includes("SENSEX") ? "YES" : "NO");

// mobile
const mob = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
mob.on("pageerror", e => { errors.push(String(e)); console.error("MOB PAGEERROR", e.message); });
await mob.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
await mob.waitForSelector("header", { timeout: 60000 });
await mob.getByRole("button", { name: "Open instrument list" }).tap();
await mob.waitForTimeout(500);
const mvp = mob.viewportSize();
// drawer rail
const dBox = await mob.locator("aside").filter({ has: mob.getByRole("button", { name: "Open" }) }).first().boundingBox().catch(()=>null)
  ?? await mob.locator("aside").first().boundingBox();
console.log(`MOBILE drawer w=${Math.round(dBox.width)} (${Math.round(dBox.width/mvp.width*100)}% of screen)`);
// expand to the shared full-screen panel
await mob.getByRole("button", { name: "Expand panel to full screen" }).first().tap();
await mob.waitForTimeout(500);
const mbox = await mob.locator("aside").filter({ has: mob.getByRole("button", { name: "Close panel" }) }).boundingBox();
console.log(`MOBILE full panel w=${Math.round(mbox.width)} h=${Math.round(mbox.height)} (${Math.round(mbox.width/mvp.width*100)}% of screen)`);
console.log("mobile full screen:", mbox.width > mvp.width*0.9 && mbox.height > mvp.height*0.8 ? "YES" : "NO");
await mob.getByRole("button", { name: "Close panel" }).tap(); await mob.waitForTimeout(300);
console.log("mobile close works:", (await mob.getByRole("button", { name: "Close panel" }).count()) === 0 ? "YES" : "NO");

console.log("ERRORS:", errors.length);
await browser.close();
process.exit(errors.length ? 1 : 0);
