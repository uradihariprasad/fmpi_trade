import { chromium } from "playwright";

const url = process.env.TEST_URL ?? "http://127.0.0.1:3102";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => { errors.push(`PAGEERROR ${e.stack ?? e.message}`); console.error(errors.at(-1)); });
page.on("console", (m) => { if (m.type() === "error") { errors.push(`CONSOLE ${m.text()}`); console.error(errors.at(-1)); } });
page.on("response", async (r) => {
  if (r.status() >= 500) console.error(`HTTP ${r.status()} ${r.url()}`);
});

await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForSelector("text=FMPI ENGINE", { timeout: 60_000 });
// Wait for a real chart payload, but don't block forever if upstream is slow.
await page.waitForFunction(() => !document.body.innerText.includes("fetching genuine"), null, { timeout: 120_000 }).catch(() => {});

const report = async (name, fn) => {
  try {
    await fn();
    await page.waitForTimeout(300);
    console.log(`PASS ${name}`);
  } catch (e) {
    errors.push(`ACTION ${name}: ${e.message}`);
    console.error(`FAIL ${name}: ${e.message}`);
  }
};

await report("canvas click", async () => {
  const canvas = page.locator("canvas").first();
  await canvas.click({ position: { x: 250, y: 160 } });
});
await report("10 MIN", () => page.getByRole("button", { name: "10 MIN" }).click());
await report("5 MIN", () => page.getByRole("button", { name: "5 MIN" }).click());
await report("TOP 10 tab", () => page.getByRole("button", { name: /TOP 10/ }).first().click());
await report("ALL tab", () => page.getByRole("button", { name: /^ALL$/ }).first().click());
await report("TRADES tab", () => page.getByRole("button", { name: /^TRADES$/ }).first().click());
for (const name of ["STATE", "ZONES", "EVIDENCE", "METHOD"]) {
  await report(`${name} intel tab`, () => page.getByRole("button", { name: new RegExp(`^${name}$`) }).click());
}
await report("login open", () => page.getByRole("button", { name: "Upstox session" }).click());
await report("login eye", async () => {
  const eye = page.getByRole("button", { name: "Toggle visibility" });
  if (await eye.isVisible()) await eye.click();
});
await report("login close", () => page.getByRole("button", { name: "Close", exact: true }).click());
await report("instrument universe", async () => {
  await page.getByRole("button", { name: /^ALL$/ }).first().click();
  const rel = page.getByRole("button", { name: /RELIANCE/ }).first();
  await rel.click();
});
await page.waitForTimeout(2_000);

const body = await page.locator("body").innerText();
if (/This page couldn.t load|Reload to try again/i.test(body)) errors.push("FATAL UI error page displayed");
console.log(`FINAL url=${page.url()} bodyChars=${body.length} errors=${errors.length}`);
if (errors.length) console.log(errors.join("\n---\n"));
await browser.close();
process.exit(errors.length ? 1 : 0);
