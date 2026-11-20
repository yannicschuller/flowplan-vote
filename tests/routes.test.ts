import { test } from "node:test";
import assert from "node:assert/strict";
import { BASE, allow, body, req, setup, signIn } from "./helpers";
import { startGitHubMock } from "./github-mock";
import { defaultShots, fakeManifest, fakeShot } from "./gallery-mock";
import { handle } from "../lib/http";
import { callbackRoute, deckRoute, healthRoute, loginRoute, logoutRoute, voteRoute, votesRoute } from "../lib/routes";
import { CACHE_MS, forgetGallery, gallery } from "../lib/gallery";
import { one } from "../lib/db";
import { userForSessionToken } from "../lib/auth";

const { gallery: mock } = await setup();
const github = await startGitHubMock();
const call = (fn: () => Promise<Response> | Response) => handle(fn);
const deckOf = async (cookie: string, query = "") => body(await call(() => deckRoute(req(`/api/deck${query}`, { cookie }))));
const cast = (cookie: string, json: Record<string, unknown>) => call(() => votesRoute(req("/api/votes", { method: "POST", json, cookie })));
const homeDesktop = { scene: "home", variant: "desktop-light", hash: "home-desktop-light-h1" };

test("health answers with the service name", async () => {
  assert.deepEqual(await body(await call(() => healthRoute())), { service: "flowplan-vote", status: "ok" });
});

test("list mode: only allowed logins get an account and a session", async () => {
  allow("someone-else");
  const start = await call(() => loginRoute(req("/api/auth/login?next=/mine")));
  assert.equal(start.status, 303);
  const location = new URL(start.headers.get("location")!);
  assert.equal(location.origin + location.pathname, `${github.base}/login/oauth/authorize`);
  assert.equal(location.searchParams.get("redirect_uri"), `${BASE}/api/auth/callback`);
  const state = location.searchParams.get("state")!;
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
  const back = (code = "good-code", s = state) => call(() => callbackRoute(req(`/api/auth/callback?code=${code}&state=${s}`, { cookie: stateCookie })));

  const denied = await back();
  assert.equal(denied.headers.get("location"), "/login?error=not_allowed&login=Octo-Voter");
  assert.equal(one("SELECT 1 AS x FROM users WHERE login='Octo-Voter'"), undefined, "nothing stored about a login not on the list");

  assert.equal((await back("good-code", "forged")).headers.get("location"), "/login?error=github_state");
  assert.equal((await back("bad-code")).headers.get("location"), "/login?error=github_failed");

  allow("octo-voter");
  const ok = await back();
  assert.equal(ok.headers.get("location"), "/mine");
  const session = ok.headers.getSetCookie().find((c) => c.startsWith("fv_session="))!;
  assert.match(session, /HttpOnly; SameSite=Lax/);
  const token = decodeURIComponent(session.split(";")[0].slice("fv_session=".length));
  assert.equal(userForSessionToken(token)!.allowed, true);
  // Taken off the list: the session no longer allows voting.
  allow("someone-else");
  const r = await call(() => deckRoute(req("/api/deck", { cookie: `fv_session=${token}` })));
  assert.equal(r.status, 403);
  assert.equal((await body(r)).error, "not_allowed");
  // Signing out still works.
  const out = await call(() => logoutRoute(req("/api/auth/logout", { method: "POST", form: {}, cookie: `fv_session=${token}` })));
  assert.equal(out.status, 303);
  assert.equal(userForSessionToken(token), null);
});

// One OAuth round trip with the mock: start, then the callback with the given code.
async function signInViaGitHub(code = "good-code") {
  const start = await call(() => loginRoute(req("/api/auth/login")));
  const state = new URL(start.headers.get("location")!).searchParams.get("state")!;
  const stateCookie = start.headers.get("set-cookie")!.split(";")[0];
  return call(() => callbackRoute(req(`/api/auth/callback?code=${code}&state=${state}`, { cookie: stateCookie })));
}
const sessionTokenOf = (r: Response) => {
  const c = r.headers.getSetCookie().find((x) => x.startsWith("fv_session="));
  return c ? decodeURIComponent(c.split(";")[0].slice("fv_session=".length)) : null;
};
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

test("open mode (*): any GitHub login gets an account and may vote", async () => {
  process.env.VOTE_ALLOWED_LOGINS = "*";
  github.oauth.user = { id: 5001, login: "Stranger-1", name: "Stranger", created_at: daysAgo(400) };
  const ok = await signInViaGitHub();
  assert.equal(ok.headers.get("location"), "/");
  const token = sessionTokenOf(ok)!;
  assert.equal(userForSessionToken(token)!.allowed, true);
  assert.equal((await cast(`fv_session=${token}`, { ...homeDesktop, verdict: "up" })).status, 200);
  // Only GitHub id, login and name are stored – not the account's age.
  const row = one<Record<string, unknown>>("SELECT * FROM users WHERE github_id=5001")!;
  assert.deepEqual(Object.keys(row).sort(), ["created_at", "github_id", "id", "last_login_at", "login", "name"]);
  // Back to list mode: the session no longer votes.
  allow("someone-else");
  assert.equal((await cast(`fv_session=${token}`, { ...homeDesktop, verdict: "up" })).status, 403);
});

test("open mode: an account younger than VOTE_MIN_ACCOUNT_AGE_DAYS is refused", async () => {
  process.env.VOTE_ALLOWED_LOGINS = "*";
  github.oauth.user = { id: 5002, login: "Fresh-Account", name: "", created_at: daysAgo(3) };
  const young = await signInViaGitHub();
  assert.equal(young.headers.get("location"), "/login?error=account_too_new&login=Fresh-Account");
  assert.equal(sessionTokenOf(young), null);
  assert.equal(one("SELECT 1 AS x FROM users WHERE github_id=5002"), undefined, "nothing stored about a refused account");
  // Default is 30 days; a custom value and 0 (off) are honoured.
  github.oauth.user = { id: 5002, login: "Fresh-Account", name: "", created_at: daysAgo(10) };
  assert.equal((await signInViaGitHub()).headers.get("location"), "/login?error=account_too_new&login=Fresh-Account");
  process.env.VOTE_MIN_ACCOUNT_AGE_DAYS = "7";
  assert.equal((await signInViaGitHub()).headers.get("location"), "/");
  github.oauth.user = { id: 5003, login: "Brand-New", name: "" };
  process.env.VOTE_MIN_ACCOUNT_AGE_DAYS = "1";
  assert.equal((await signInViaGitHub()).headers.get("location"), "/login?error=account_too_new&login=Brand-New", "no created_at counts as too young");
  process.env.VOTE_MIN_ACCOUNT_AGE_DAYS = "0";
  assert.equal((await signInViaGitHub()).headers.get("location"), "/");
  // List mode ignores the account age.
  delete process.env.VOTE_MIN_ACCOUNT_AGE_DAYS;
  github.oauth.user = { id: 5004, login: "Listed-Young", name: "", created_at: daysAgo(1) };
  allow("listed-young");
  assert.equal((await signInViaGitHub()).headers.get("location"), "/");
});

test("VOTE_BLOCKED_LOGINS refuses a login in open and list mode, also with a session", async () => {
  process.env.VOTE_ALLOWED_LOGINS = "*";
  github.oauth.user = { id: 5005, login: "Troll", name: "", created_at: daysAgo(900) };
  const ok = await signInViaGitHub();
  const token = sessionTokenOf(ok)!;
  process.env.VOTE_BLOCKED_LOGINS = "someone, troll";
  assert.equal((await signInViaGitHub()).headers.get("location"), "/login?error=not_allowed&login=Troll");
  const r = await cast(`fv_session=${token}`, { ...homeDesktop, verdict: "down" });
  assert.equal(r.status, 403, "blocked at once, even with a valid session");
  assert.equal((await body(r)).error, "not_allowed");
  allow("troll");
  assert.equal((await signInViaGitHub()).headers.get("location"), "/login?error=not_allowed&login=Troll", "blocking wins over the list");
  delete process.env.VOTE_BLOCKED_LOGINS;
  github.oauth.user = { id: 4242, login: "Octo-Voter", name: "Octo", created_at: "2015-03-01T10:00:00Z" };
});

test("without client id and secret the sign-in is off", async () => {
  const saved = process.env.VOTE_GITHUB_CLIENT_SECRET;
  delete process.env.VOTE_GITHUB_CLIENT_SECRET;
  const r = await call(() => loginRoute(req("/api/auth/login")));
  assert.equal(r.headers.get("location"), "/login?error=github_off");
  process.env.VOTE_GITHUB_CLIENT_SECRET = saved;
});

test("CSRF and session: writing needs this site's Origin and a session", async () => {
  allow("anna");
  const { cookie } = signIn("anna");
  for (const origin of [null, "https://evil.example", "null"]) {
    const r = await call(() => votesRoute(req("/api/votes", { method: "POST", json: { ...homeDesktop, verdict: "up" }, cookie, origin })));
    assert.equal(r.status, 403, `origin ${origin}`);
  }
  const r = await cast("fv_session=nope", { ...homeDesktop, verdict: "up" });
  assert.equal(r.status, 401);
});

test("the deck: unvoted images, then changed ones; show all; filters", async () => {
  allow("ben");
  const { cookie } = signIn("ben");
  let d = await deckOf(cookie);
  assert.equal(d.cards.length, 12, "the failed shot is not in the deck");
  assert.deepEqual(d.progress, { total: 12, voted: 0 });
  assert.equal(d.cards[0].image, `${mock.base}/shots/home--desktop-light.png`);

  assert.equal((await cast(cookie, { ...homeDesktop, verdict: "down", comment: "  Too much space on the left  " })).status, 200);
  assert.equal((await cast(cookie, { scene: "home", variant: "phone-dark", hash: "home-phone-dark-h1", verdict: "skip" })).status, 200);
  d = await deckOf(cookie);
  assert.equal(d.cards.length, 10, "voted and skipped images leave the deck");
  assert.deepEqual(d.progress, { total: 12, voted: 2 });
  const all = await deckOf(cookie, "?all=1");
  assert.equal(all.cards.length, 12);
  assert.deepEqual(all.cards[0].vote, { verdict: "down", comment: "Too much space on the left" });
  assert.equal((await deckOf(cookie, "?group=Settings")).cards.length, 4);
  assert.equal((await deckOf(cookie, "?variant=phone-dark")).cards.length, 2);

  // The next night: the home desktop image changed – it is back, marked as changed.
  const shots = defaultShots().map((s) => (s.scene === "home" && s.variant === "desktop-light" ? { ...s, hash: "home-desktop-light-h2" } : s));
  mock.setManifest(fakeManifest(shots, { generated: "2026-11-20T02:00:00.000Z", commit: "c".repeat(40), version: "1.43.0" }));
  // The cache runs out (the recent runs stay known).
  await gallery(Date.now() + 2 * CACHE_MS);
  d = await deckOf(cookie);
  assert.equal(d.cards.length, 11);
  const back = d.cards.find((c: { scene: string; variant: string }) => c.scene === "home" && c.variant === "desktop-light");
  assert.equal(back.hash, "home-desktop-light-h2");
  assert.equal(back.changed.verdict, "down");
  // A vote on the old image (sent just before the new run) is still accepted.
  assert.equal((await cast(cookie, { ...homeDesktop, verdict: "down", comment: "late" })).status, 200);
  mock.setManifest(fakeManifest(defaultShots()));
  forgetGallery();
});

test("votes: replace on the same image, undo, validation", async () => {
  allow("cleo");
  const { cookie, user } = signIn("cleo");
  const first = await body(await cast(cookie, { ...homeDesktop, verdict: "up" }));
  assert.equal(first.previous, null);
  assert.equal(first.vote.group, "Pages");
  assert.equal(first.vote.title, "Home");
  assert.equal(first.vote.commit, "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678");
  const second = await body(await cast(cookie, { ...homeDesktop, verdict: "down", comment: "Zu eng" }));
  assert.deepEqual(second.previous, { verdict: "up", comment: "" });
  assert.equal(second.vote.id, first.vote.id, "same image, same vote");
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM votes WHERE user_id=?", user.id)!.n, 1);
  // Undo of a first vote: delete it.
  const del = await call(() => votesRoute(req("/api/votes", { method: "DELETE", json: homeDesktop, cookie })));
  assert.equal((await body(del)).deleted, 1);
  assert.equal(one<{ n: number }>("SELECT COUNT(*) AS n FROM votes WHERE user_id=?", user.id)!.n, 0);

  const bad = async (json: Record<string, unknown>, status: number, error: string) => {
    const r = await cast(cookie, json);
    assert.equal(r.status, status, JSON.stringify(json));
    assert.equal((await body(r)).error, error);
  };
  await bad({ ...homeDesktop, verdict: "meh" }, 400, "invalid_verdict");
  await bad({ ...homeDesktop, hash: "unknown" , verdict: "up" }, 409, "unknown_shot");
  await bad({ scene: "broken", variant: "desktop-light", hash: "broken-desktop-light-h1", verdict: "up" }, 409, "unknown_shot");
  await bad({ ...homeDesktop, verdict: "up", comment: "x".repeat(501) }, 400, "comment_too_long");
  await bad({ variant: "desktop-light", hash: "x", verdict: "up" }, 400, "invalid_scene");
  assert.equal((await cast(cookie, { ...homeDesktop, verdict: "up", comment: "ä".repeat(500) })).status, 200, "500 characters are fine");
});

test("the gallery down: the deck and new votes answer 503", async () => {
  allow("dora");
  const { cookie } = signIn("dora");
  forgetGallery();
  mock.setStatus(502);
  const r = await call(() => deckRoute(req("/api/deck", { cookie })));
  assert.equal(r.status, 503);
  assert.equal((await body(r)).error, "gallery_unavailable");
  assert.equal((await cast(cookie, { ...homeDesktop, verdict: "up" })).status, 503);
  mock.setStatus(200);
  forgetGallery();
});

test("my votes: change and delete only my own", async () => {
  allow("emil", "fritz");
  const emil = signIn("emil");
  const fritz = signIn("fritz");
  const { vote } = await body(await cast(emil.cookie, { ...homeDesktop, verdict: "up" }));
  const patch = (cookie: string, json: unknown, id = vote.id) => call(() => voteRoute(req(`/api/votes/${id}`, { method: "PATCH", json, cookie }), String(id)));
  const changed = await body(await patch(emil.cookie, { verdict: "down", comment: "Kontrast im Dark Mode" }));
  assert.equal(changed.vote.verdict, "down");
  assert.equal(changed.vote.comment, "Kontrast im Dark Mode");
  assert.equal((await patch(emil.cookie, { comment: "" })).status, 200);
  assert.equal((await patch(fritz.cookie, { verdict: "up" })).status, 404, "someone else's vote");
  assert.equal((await patch(emil.cookie, { verdict: "nope" })).status, 400);
  const delFritz = await call(() => voteRoute(req(`/api/votes/${vote.id}`, { method: "DELETE", cookie: fritz.cookie }), String(vote.id)));
  assert.equal(delFritz.status, 404);
  const del = await call(() => voteRoute(req(`/api/votes/${vote.id}`, { method: "DELETE", cookie: emil.cookie }), String(vote.id)));
  assert.equal(del.status, 200);
  assert.equal(one("SELECT 1 AS x FROM votes WHERE id=?", vote.id), undefined);
});

test("rate limit: too many votes per minute answer 429", async () => {
  allow("gina");
  const { cookie } = signIn("gina");
  let last: Response | null = null;
  for (let i = 0; i < 181; i++) last = await cast(cookie, { ...homeDesktop, verdict: i % 2 ? "up" : "down" });
  assert.equal(last!.status, 429);
  assert.ok(Number(last!.headers.get("retry-after")) > 0);
});

test("one more image: a new scene in a new run lands in the deck", async () => {
  allow("hans");
  const { cookie } = signIn("hans");
  mock.setManifest(fakeManifest([...defaultShots(), fakeShot("journal", "Pages", "Journal", "phone-light")]));
  forgetGallery();
  assert.equal((await deckOf(cookie)).cards.length, 13);
  mock.setManifest(fakeManifest(defaultShots()));
  forgetGallery();
});
