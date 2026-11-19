// Screenshots of the voting screen and the other pages for a visual check
// (not part of the smoke test): SCREENSHOTS_DIR=/some/dir npm run test:browser.
// Desktop 1440×900 and phone 390×844, light and dark; fails on horizontal
// overflow.
import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../../playwright.config";

const dir = process.env.SCREENSHOTS_DIR;
test.skip(!dir, "SCREENSHOTS_DIR not set");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

async function overflow(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("voting screen and pages at desktop and phone size, light and dark", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const seed = JSON.parse(readFileSync(join(dataDir, "browser-test.json"), "utf8")) as { shooter: string };
  const wide: string[] = [];
  for (const viewport of VIEWPORTS)
    for (const colorScheme of ["light", "dark"] as const) {
      const locale = colorScheme === "light" ? "de-DE" : "en-GB";
      const context = await browser.newContext({ viewport, colorScheme, locale, hasTouch: viewport.name === "phone", isMobile: viewport.name === "phone" });
      await context.addCookies([{ name: "fv_session", value: seed.shooter, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
      const page = await context.newPage();
      const shot = async (name: string, fullPage = false) => {
        const w = await overflow(page);
        if (w > 0) wide.push(`${name} ${viewport.name} ${colorScheme}: ${w}px`);
        await page.screenshot({ path: join(dir!, `${name}-${viewport.name}-${colorScheme}.png`), fullPage });
      };
      await page.goto("/");
      await expect(page.locator(".vote-card.depth-0 img")).toHaveClass(/ready/);
      await page.waitForLoadState("networkidle");
      await shot("vote");

      // Mid-drag to the left: tilt, red tint, stamp.
      const card = page.locator(".vote-card.depth-0");
      await card.evaluate((el) => {
        el.classList.add("dragging");
        for (const [k, v] of Object.entries({ "--dx": "-90px", "--dy": "6px", "--rot": "-5deg", "--drag-nope": "0.85", "--drag-like": "0", "--drag-skip": "0" })) el.style.setProperty(k, v);
      });
      await shot("vote-drag");
      await card.evaluate((el) => {
        el.classList.remove("dragging");
        for (const k of ["--dx", "--dy", "--rot", "--drag-nope"]) el.style.setProperty(k, k === "--drag-nope" ? "0" : "0px");
      });

      // A comment open, a phone-sized card on top.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(page.locator(".progress-count")).toContainText("3");
      await page.getByRole("button", { name: /Kommentar \(K\)|Comment \(K\)/ }).click();
      await page.locator("#vote-comment").fill(colorScheme === "light" ? "Die Tab-Leiste ist abgeschnitten." : "The tab bar is cut off.");
      await page.waitForTimeout(350);
      await shot("vote-comment");
      await page.getByRole("button", { name: /^(Schließen|Close)$/ }).first().click();

      await page.keyboard.press("?");
      await shot("help");
      await page.keyboard.press("Escape");

      // Everything voted: the empty state; then undo it all again.
      for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowDown");
      await expect(page.locator(".done-state")).toBeVisible();
      await page.waitForTimeout(300);
      await shot("vote-done");
      await page.goto("/mine");
      await shot("mine", true);
      await page.goto("/");
      await page.getByText("Filter", { exact: true }).click();
      await page.getByRole("switch").check();
      await expect(page.locator(".vote-card.depth-0 img")).toHaveClass(/ready/);
      await shot("vote-all-filters");
      // Clean up for the next run: delete the votes of this session.
      await page.evaluate(async () => {
        const res = await fetch("/api/deck?all=1");
        const { cards } = (await res.json()) as { cards: { scene: string; variant: string; hash: string }[] };
        for (const c of cards) await fetch("/api/votes", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(c) });
      });
      await context.clearCookies();
      await page.goto("/login");
      await shot("login");
      await context.close();
    }
  expect(wide).toEqual([]);
});
