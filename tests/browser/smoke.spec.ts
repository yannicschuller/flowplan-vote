// Smoke test in a real browser: vote with keys, buttons and a mouse swipe,
// comment, undo, the full image and the help; "My votes"; the admin API with
// its token; no access for a login that is not on the list. No GitHub: the
// session comes straight from the database.
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_TOKEN, dataDir } from "../../playwright.config";

const seed = () => JSON.parse(readFileSync(join(dataDir, "browser-test.json"), "utf8")) as { voter: string; outsider: string; gallery: string };

async function signedIn(context: BrowserContext, token: string, baseURL: string) {
  await context.addCookies([{ name: "fv_session", value: token, url: baseURL, httpOnly: true, sameSite: "Lax" }]);
}
// Any violation of the Content Security Policy shows up as a console error.
function watchCsp(page: Page) {
  const violations: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text());
  });
  return violations;
}
const title = (page: Page) => page.locator(".vote-card.depth-0 h2");
const count = (page: Page) => page.locator(".progress-count");
// Waits until every queued vote reached the server.
const settled = (page: Page) => expect(page.locator(".sync-state")).toHaveCount(0);

test("vote with keys, buttons and a swipe; comment; undo; my votes; admin API", async ({ browser, baseURL, request }) => {
  const { voter } = seed();
  const context = await browser.newContext({ locale: "en-GB", viewport: { width: 1280, height: 860 } });
  await signedIn(context, voter, baseURL!);
  const page = await context.newPage();
  const csp = watchCsp(page);
  await page.goto("/");
  await expect(title(page)).toHaveText("Home");
  await expect(count(page)).toHaveText("1 / 12");
  await expect(page.locator(".vote-card.depth-0 img")).toHaveClass(/ready/);
  await expect(page.locator(".vote-card.depth-0 .chip.variant")).toHaveText("Desktop · light");

  // → like, ← dislike, ↓ skip.
  await page.keyboard.press("ArrowRight");
  await expect(count(page)).toHaveText("2 / 12");
  await expect(page.getByRole("status").filter({ hasText: "Like: Home" })).toHaveCount(1);
  await page.keyboard.press("ArrowLeft");
  await expect(count(page)).toHaveText("3 / 12");
  await page.keyboard.press("ArrowDown");
  await expect(count(page)).toHaveText("4 / 12");
  // Z undoes the skip.
  await page.keyboard.press("z");
  await expect(count(page)).toHaveText("3 / 12");
  await expect(page.locator(".vote-card.depth-0 .chip.variant")).toHaveText("Phone · light");

  // K: a comment, sent with the next verdict (the button).
  await page.keyboard.press("k");
  const field = page.getByRole("textbox", { name: /Comment/ });
  await expect(field).toBeFocused();
  await field.fill("The tab bar is cut off");
  await page.keyboard.press("Escape");
  await expect(field).toBeVisible();
  await page.getByRole("button", { name: "Dislike (left arrow)" }).click();
  await expect(field).toHaveCount(0);
  await expect(count(page)).toHaveText("4 / 12");

  // Swipe right with the mouse: the card tilts and shows the stamp, then goes.
  const card = page.locator(".vote-card.depth-0");
  const box = (await card.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 10, { steps: 6 });
  await expect(card).toHaveClass(/dragging/);
  expect(Number(await card.evaluate((el) => el.style.getPropertyValue("--drag-like")))).toBeGreaterThan(0.3);
  await page.mouse.move(box.x + box.width / 2 + 420, box.y + box.height / 2 + 10, { steps: 6 });
  await page.mouse.up();
  await expect(count(page)).toHaveText("5 / 12");
  // A short drag springs back.
  const next = await title(page).innerText();
  const box2 = (await card.boundingBox())!;
  await page.mouse.move(box2.x + 200, box2.y + 200);
  await page.mouse.down();
  await page.mouse.move(box2.x + 240, box2.y + 200, { steps: 3 });
  await page.mouse.up();
  await expect(count(page)).toHaveText("5 / 12");
  await expect(title(page)).toHaveText(next);

  // Enter: the full image; ?: the help.
  await page.locator("body").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("dialog.lightbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.lightbox")).toBeHidden();
  await page.keyboard.press("?");
  await expect(page.getByRole("heading", { name: "Shortcuts and gestures" })).toBeVisible();
  await page.keyboard.press("Escape");

  // A comment after the verdict.
  await page.getByRole("button", { name: "Like (right arrow)" }).click();
  await expect(count(page)).toHaveText("6 / 12");
  await page.getByRole("button", { name: "Add a comment" }).click();
  await page.getByRole("textbox", { name: /Comment on your last vote/ }).fill("Looks great");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await settled(page);

  // A reload keeps the deck: five images voted on.
  await page.reload();
  await expect(count(page)).toHaveText("6 / 12");
  // Filters: only phone-dark, then everything with "show all".
  await page.getByText("Filter", { exact: true }).click();
  await page.getByLabel("Variant").selectOption("phone-dark");
  await expect(count(page)).toHaveText(/\/ 3$/);
  await page.getByRole("switch", { name: /Show all/ }).check();
  await expect(count(page)).toHaveText("1 / 3");
  await page.getByLabel("Variant").selectOption("");
  await page.getByRole("switch", { name: /Show all/ }).uncheck();
  await expect(count(page)).toHaveText("6 / 12");

  // Vote the rest: the empty state.
  for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("heading", { name: "All done – the next gallery arrives tonight" })).toBeVisible();
  await settled(page);

  // My votes: twelve, change one, delete one.
  await page.getByRole("link", { name: "My votes" }).first().click();
  await expect(page.getByRole("heading", { name: "My votes", level: 1 })).toBeVisible();
  await expect(page.locator(".vote-item")).toHaveCount(12);
  await page.getByRole("button", { name: /^Dislike \(\d+\)$/ }).click();
  await expect(page.locator(".vote-item")).toHaveCount(2);
  await expect(page.locator(".vote-item .vote-comment").first()).toHaveText("The tab bar is cut off");
  const item = page.locator(".vote-item").first();
  await item.getByRole("button", { name: "Like", exact: true }).click();
  await expect(page.locator(".notice.ok")).toHaveText("Saved.");
  await item.getByRole("button", { name: "Delete" }).click();
  await item.getByRole("button", { name: "Really delete" }).click();
  await expect(page.locator(".notice.ok")).toContainText("Vote deleted");
  expect(csp).toEqual([]);
  await context.close();

  // The admin API: token required, the counts as voted here.
  expect((await request.get("/api/admin/summary")).status()).toBe(401);
  const summary = await (await request.get("/api/admin/summary", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  expect(summary.totals.voters).toBe(1);
  expect(summary.totals.up + summary.totals.down + summary.totals.skip).toBe(11);
  expect(summary.gallery.shots).toBe(12);
  const votes = await (await request.get("/api/admin/votes?limit=1", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  expect(votes.votes).toHaveLength(1);
  expect(votes.nextCursor).toBeTruthy();
  const prompt = await (await request.get("/api/admin/prompt?scope=current&includeUp=1", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } })).json();
  expect(prompt.prompt).toContain("Design-Feedback aus flowplan-vote");
  const csv = await request.get("/api/admin/export?format=csv", { headers: { Authorization: `Bearer ${ADMIN_TOKEN}` } });
  expect(csv.headers()["content-type"]).toBe("text/csv; charset=utf-8");
});

test("a login that is not on the list sees no access", async ({ browser, baseURL }) => {
  const { outsider } = seed();
  const context = await browser.newContext({ locale: "de-DE" });
  await signedIn(context, outsider, baseURL!);
  const page = await context.newPage();
  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?error=not_allowed/);
  await expect(page.getByText("Kein Zugang")).toBeVisible();
  await context.close();
  const anonymous = await browser.newContext({ locale: "de-DE" });
  const p = await anonymous.newPage();
  await p.goto("/");
  await expect(p).toHaveURL(/\/login$/);
  await expect(p.getByRole("heading", { name: "Galerie bewerten" })).toBeVisible();
  await anonymous.close();
});
