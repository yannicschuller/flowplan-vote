// The maintainer's tools in the admin API: votes filtered by person, the
// voters list, and dismissing votes (a soft reset: the vote counts nowhere
// and the image is back in the person's deck) with restore.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ADMIN_TOKEN, allow, body, req, setup, signIn } from "./helpers";
import { handle } from "../lib/http";
import { adminRoute, deckRoute, voteRoute, votesRoute } from "../lib/routes";
import { MIGRATIONS, SCHEMA_VERSION, migrate, one, run } from "../lib/db";
import { myVotes, resetCount } from "../lib/votes";

await setup();
process.env.VOTE_ADMIN_TOKEN = ADMIN_TOKEN;
const call = (fn: () => Promise<Response> | Response) => handle(fn);
const admin = (path: string, json?: Record<string, unknown>, method = json ? "POST" : "GET") => {
  const name = new URL(path, "http://x").pathname.replace(/^\/api\/admin\//, "");
  return call(() => adminRoute(req(path, { method, json, origin: null, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), name));
};
const cast = (cookie: string, json: Record<string, unknown>) => call(() => votesRoute(req("/api/votes", { method: "POST", json, cookie })));
const deckOf = async (cookie: string, query = "") => body(await call(() => deckRoute(req(`/api/deck${query}`, { cookie }))));
const shot = (scene: string, variant: string) => ({ scene, variant, hash: `${scene}-${variant}-h1` });
const find = (cards: { scene: string; variant: string }[], scene: string, variant: string) => cards.find((c) => c.scene === scene && c.variant === variant) as Record<string, any> | undefined;
const BY = "yannic@example.org";

allow("anna", "ben");
const anna = signIn("anna");
const ben = signIn("ben");
await cast(anna.cookie, { ...shot("home", "desktop-light"), verdict: "down", comment: "Seitenleiste zu breit" });
await cast(anna.cookie, { ...shot("home", "phone-dark"), verdict: "down" });
await cast(anna.cookie, { ...shot("document-editor", "desktop-light"), verdict: "up" });
await cast(ben.cookie, { ...shot("home", "desktop-light"), verdict: "down", comment: "Zu viel Weißraum" });
await cast(ben.cookie, { ...shot("document-editor", "phone-light"), verdict: "up" });
run("UPDATE votes SET created_at = 1700000000000 + id * 1000");
const voteId = (login: string, scene: string, variant: string) =>
  one<{ id: number }>("SELECT v.id FROM votes v JOIN users u ON u.id=v.user_id WHERE u.login=? AND v.scene=? AND v.variant=?", login, scene, variant)!.id;

test("votes by person (login, any case, or account id); voters with counts", async () => {
  const byLogin = await body(await admin("/api/admin/votes?user=ANNA"));
  assert.equal(byLogin.votes.length, 3);
  assert.ok(byLogin.votes.every((v: { login: string; userId: number }) => v.login === "anna" && v.userId === anna.user.id));
  const byId = await body(await admin(`/api/admin/votes?user=${ben.user.id}`));
  assert.deepEqual(byId.votes.map((v: { login: string }) => v.login), ["ben", "ben"]);
  assert.equal((await body(await admin("/api/admin/votes?user=anna&verdict=down"))).votes.length, 2, "with the other filters");
  const unknown = await admin("/api/admin/votes?user=nobody");
  assert.equal(unknown.status, 404);
  assert.equal((await body(unknown)).error, "unknown_user");

  const { voters } = await body(await admin("/api/admin/voters"));
  assert.deepEqual(voters, [
    { userId: anna.user.id, login: "anna", name: "anna", votes: 3, up: 1, down: 2, skip: 0, comments: 1, dismissed: 0, lastVoteAt: new Date(1700000003000).toISOString() },
    { userId: ben.user.id, login: "ben", name: "ben", votes: 2, up: 1, down: 1, skip: 0, comments: 1, dismissed: 0, lastVoteAt: new Date(1700000005000).toISOString() },
  ]);
  assert.equal((await admin("/api/admin/voters", {}, "POST")).status, 405, "reads are GET only");
});

test("dismiss one vote: it counts nowhere, the image is back in the deck with a hint; restore undoes it", async () => {
  const id = voteId("anna", "home", "desktop-light");
  const before = await body(await admin("/api/admin/summary"));
  assert.deepEqual([before.totals.down, before.totals.comments], [3, 2]);
  assert.equal(find((await deckOf(anna.cookie)).cards, "home", "desktop-light"), undefined, "voted: not in the deck");

  const r = await body(await admin(`/api/admin/votes/${id}/dismiss`, { by: BY }));
  assert.equal(r.changed, true);
  assert.equal(r.vote.dismissed, true);
  assert.equal(r.vote.dismissedBy, BY);
  assert.ok(Date.parse(r.vote.dismissedAt) > 0);
  // Idempotent: the first dismiss stays.
  const again = await body(await admin(`/api/admin/votes/${id}/dismiss`, { by: "someone else" }));
  assert.equal(again.changed, false);
  assert.equal(again.vote.dismissedBy, BY);
  assert.equal(again.vote.dismissedAt, r.vote.dismissedAt);

  // Counts nowhere: summary, scenes, prompt, export, the default list.
  const after = await body(await admin("/api/admin/summary"));
  assert.deepEqual([after.totals.down, after.totals.comments, after.totals.voters], [2, 1, 2]);
  const home = (await body(await admin("/api/admin/scenes"))).scenes.find((s: { scene: string }) => s.scene === "home");
  assert.deepEqual([home.down, home.comments], [2, 1]);
  const { prompt } = await body(await admin("/api/admin/prompt"));
  assert.ok(!prompt.includes("Seitenleiste zu breit"), "a dismissed comment is not in the prompt");
  assert.ok(!/\b(anna|ben)\b/i.test(prompt), "still no logins in the prompt");
  assert.ok(!(await body(await admin("/api/admin/export?format=json"))).votes.some((v: { id: number }) => v.id === id));
  assert.ok(!(await body(await admin("/api/admin/votes"))).votes.some((v: { id: number }) => v.id === id), "left out by default");
  const only = await body(await admin("/api/admin/votes?dismissed=only"));
  assert.deepEqual(only.votes.map((v: { id: number }) => v.id), [id]);
  assert.equal((await body(await admin("/api/admin/votes?dismissed=include&user=anna"))).votes.length, 3);
  assert.equal((await admin("/api/admin/votes?dismissed=maybe")).status, 400);
  const annaRow = (await body(await admin("/api/admin/voters"))).voters.find((v: { login: string }) => v.login === "anna");
  assert.deepEqual([annaRow.votes, annaRow.down, annaRow.dismissed], [2, 1, 1]);

  // The person: the card is back, with the hint; "My votes" leaves it out.
  const d = await deckOf(anna.cookie);
  const card = find(d.cards, "home", "desktop-light")!;
  assert.ok(card, "back in the deck");
  assert.deepEqual(card.reset, { verdict: "down", at: 1700000001000 });
  assert.equal(card.changed, null);
  assert.equal(card.vote, null);
  assert.equal(d.progress.voted, 2);
  assert.equal(find(d.cards, "home", "phone-dark"), undefined, "the other votes stay");
  assert.ok(!myVotes(anna.user, null).some((v) => v.id === id));
  assert.equal(resetCount(anna.user), 1);
  // A dismissed vote is no longer the person's to edit.
  assert.equal((await call(() => voteRoute(req(`/api/votes/${id}`, { method: "PATCH", json: { verdict: "up" }, cookie: anna.cookie }), String(id)))).status, 404);

  // Restore: everything as before (idempotent too).
  const back = await body(await admin(`/api/admin/votes/${id}/restore`, {}));
  assert.equal(back.changed, true);
  assert.deepEqual([back.vote.dismissed, back.vote.dismissedAt, back.vote.dismissedBy], [false, null, null]);
  assert.equal((await body(await admin(`/api/admin/votes/${id}/restore`, {}))).changed, false);
  assert.equal((await body(await admin("/api/admin/summary"))).totals.down, 3);
  assert.equal(find((await deckOf(anna.cookie)).cards, "home", "desktop-light"), undefined);
  assert.equal(resetCount(anna.user), 0);
});

test("voting again on a dismissed image makes a normal vote of it (the same row)", async () => {
  const id = voteId("ben", "home", "desktop-light");
  await admin(`/api/admin/votes/${id}/dismiss`, { by: BY });
  const r = await body(await cast(ben.cookie, { ...shot("home", "desktop-light"), verdict: "up" }));
  assert.equal(r.vote.id, id);
  assert.equal(r.previous, null, "the dismissed vote replaced nothing that counted");
  const row = one<{ verdict: string; dismissed_at: number | null; dismissed_by: string | null }>("SELECT verdict,dismissed_at,dismissed_by FROM votes WHERE id=?", id)!;
  assert.deepEqual({ ...row }, { verdict: "up", dismissed_at: null, dismissed_by: null });
  const card = find((await deckOf(ben.cookie, "?all=1")).cards, "home", "desktop-light")!;
  assert.deepEqual([card.vote?.verdict, card.reset], ["up", null]);
  assert.equal((await body(await admin(`/api/admin/votes/${id}/restore`, {}))).changed, false);
  // Back to the starting point for the next tests.
  await cast(ben.cookie, { ...shot("home", "desktop-light"), verdict: "down", comment: "Zu viel Weißraum" });
});

test("dismiss all votes of a person (optionally one scene); restore the batch by its time", async () => {
  const scene = await body(await admin("/api/admin/voters/anna/dismiss", { by: BY, scene: "home" }));
  assert.equal(scene.dismissed, 2);
  assert.deepEqual(scene.user, { userId: anna.user.id, login: "anna" });
  assert.equal((await body(await admin("/api/admin/votes?user=anna"))).votes.length, 1, "only document-editor counts");
  const rest = await body(await admin(`/api/admin/voters/${anna.user.id}/dismiss`, { by: BY }));
  assert.equal(rest.dismissed, 1, "the votes still counting");
  const none = await body(await admin("/api/admin/voters/anna/dismiss", { by: BY }));
  assert.deepEqual([none.dismissed, none.dismissedAt], [0, null], "idempotent");
  const d = await deckOf(anna.cookie);
  assert.equal(d.progress.voted, 0);
  assert.equal(d.cards.filter((c: { reset: unknown }) => c.reset).length, 3);
  const s = await body(await admin("/api/admin/summary"));
  assert.deepEqual([s.totals.voters, s.totals.down, s.totals.up], [1, 1, 1], "only Ben counts");

  // Restore exactly the second batch, then the rest of one scene.
  const r1 = await body(await admin("/api/admin/voters/anna/restore", { dismissedAt: rest.dismissedAt }));
  assert.equal(r1.restored, 1);
  assert.deepEqual((await body(await admin("/api/admin/votes?user=anna"))).votes.map((v: { scene: string }) => v.scene), ["document-editor"]);
  const r2 = await body(await admin("/api/admin/voters/ANNA/restore", { scene: "home" }));
  assert.equal(r2.restored, 2);
  assert.equal((await body(await admin("/api/admin/votes?user=anna"))).votes.length, 3);
  assert.equal((await body(await admin("/api/admin/voters/anna/restore", {}))).restored, 0);
});

test("validation: unknown ids and people are 404, `by` is required, POST only", async () => {
  assert.equal((await admin("/api/admin/votes/99999/dismiss", { by: BY })).status, 404);
  assert.equal((await admin("/api/admin/votes/99999/restore", {})).status, 404);
  assert.equal((await admin("/api/admin/votes/abc/dismiss", { by: BY })).status, 404);
  const id = voteId("anna", "home", "phone-dark");
  const noBy = await admin(`/api/admin/votes/${id}/dismiss`, {});
  assert.equal(noBy.status, 400);
  assert.equal((await body(noBy)).error, "invalid_by");
  assert.equal((await admin(`/api/admin/votes/${id}/dismiss`, { by: "x".repeat(201) })).status, 400);
  assert.equal((await admin(`/api/admin/votes/${id}/dismiss`, undefined, "GET")).status, 405);
  assert.equal((await admin("/api/admin/voters/nobody/dismiss", { by: BY })).status, 404);
  assert.equal((await admin("/api/admin/voters/anna/restore", { dismissedAt: "yesterday" })).status, 400);
  assert.equal((await admin("/api/admin/votes/1/delete", { by: BY })).status, 404);
  assert.equal((await admin("/api/admin/summary/x")).status, 404);
  // Control characters in `by` are flattened.
  const r = await body(await admin(`/api/admin/votes/${id}/dismiss`, { by: "admin\n<b>x</b>" }));
  assert.equal(r.vote.dismissedBy, "admin <b>x</b>");
  await admin(`/api/admin/votes/${id}/restore`, {});
  // Without the token nothing changes.
  const wrong = await call(() => adminRoute(req(`/api/admin/votes/${id}/dismiss`, { method: "POST", json: { by: BY }, headers: { authorization: "Bearer nope" } }), `votes/${id}/dismiss`));
  assert.equal(wrong.status, 401);
  assert.equal(one<{ d: number | null }>("SELECT dismissed_at AS d FROM votes WHERE id=?", id)!.d, null);
});

test("migration 2 adds the dismiss columns to an existing database, votes keep counting", () => {
  const conn = new DatabaseSync(":memory:");
  conn.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version(version) VALUES(1);");
  conn.exec(MIGRATIONS[0]);
  conn.exec("INSERT INTO users(github_id,login,name,created_at) VALUES(1,'old','',0)");
  conn.exec(`INSERT INTO votes(user_id,scene,grp,title,variant,hash,gallery_generated,"commit",version,verdict,comment,created_at)
             VALUES(1,'home','Pages','Home','desktop-light','h','g','c','1','down','',1)`);
  migrate(conn);
  assert.equal((conn.prepare("SELECT version FROM schema_version").get() as { version: number }).version, SCHEMA_VERSION);
  const row = conn.prepare("SELECT dismissed_at, dismissed_by FROM votes").get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { dismissed_at: null, dismissed_by: null });
  conn.close();
});
