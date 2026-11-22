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
      // The guide on the first visit (the demo card at rest), then closed.
      await expect(page.locator("dialog.help")).toBeVisible();
      await page.locator(".swipe-card, .swipe-stamp").evaluateAll((els) => els.forEach((el) => el.getAnimations().forEach((a) => {
        a.pause();
        a.currentTime = 0;
      })));
      await shot("guide");
      await page.locator("dialog.help .help-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await shot("guide-end");
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog.help")).toBeHidden();
      await shot("vote");
      await page.locator(".actions").screenshot({ path: join(dir!, `actions-${viewport.name}-${colorScheme}.png`) });

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
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("ArrowRight");
      await expect(page.locator(".progress-count")).toContainText("3");
      await page.getByRole("button", { name: /Kommentar \(C\)|Comment \(C\)/ }).click();
      await page.locator("#vote-comment").fill(colorScheme === "light" ? "Die Tab-Leiste ist abgeschnitten." : "The tab bar is cut off.");
      await page.waitForTimeout(350);
      await shot("vote-comment");
      // Closed with the text in it: the comment button shows the draft (#439).
      await page.locator(".comment-panel").getByRole("button", { name: /^(Schließen|Close)$/ }).click();
      await expect(page.locator(".act-button.comment .draft-dot")).toBeVisible();
      await shot("vote-draft");
      await page.locator(".actions").screenshot({ path: join(dir!, `actions-draft-${viewport.name}-${colorScheme}.png`) });
      // Voted with the draft, then back: the verdict on the card, the comment loaded.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowLeft");
      await expect(page.locator(".vote-card.depth-0 .chip.verdict")).toBeVisible();
      await page.waitForTimeout(350);
      await shot("vote-back");

      await page.keyboard.press("?");
      await shot("help");
      await page.keyboard.press("Escape");

      // Everything voted: the empty state.
      for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
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
