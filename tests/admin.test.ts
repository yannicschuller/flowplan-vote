import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, allow, body, req, setup, signIn } from "./helpers";
import { defaultShots, fakeManifest } from "./gallery-mock";
import { handle } from "../lib/http";
import { adminRoute, votesRoute } from "../lib/routes";
import { CACHE_MS, gallery } from "../lib/gallery";
import { run } from "../lib/db";

const { gallery: mock } = await setup();
const admin = (path: string, token: string | null = ADMIN_TOKEN) => {
  const url = new URL(path, "http://x");
  const name = url.pathname.split("/").pop()!;
  return handle(() => adminRoute(req(path, { headers: token ? { authorization: `Bearer ${token}` } : {} }), name));
};
const cast = (cookie: string, json: Record<string, unknown>) => handle(() => votesRoute(req("/api/votes", { method: "POST", json, cookie })));
const shot = (scene: string, variant: string) => ({ scene, variant, hash: `${scene}-${variant}-h1` });

allow("anna", "ben");
const anna = signIn("anna");
const ben = signIn("ben");
// Anna: home down on desktop-light (with a comment) and phone-dark, editor up, settings skipped.
await cast(anna.cookie, { ...shot("home", "desktop-light"), verdict: "down", comment: "Die Seitenleiste ist zu breit.\nUnd der Kopf zu hoch." });
await cast(anna.cookie, { ...shot("home", "phone-dark"), verdict: "down" });
await cast(anna.cookie, { ...shot("document-editor", "desktop-light"), verdict: "up" });
await cast(anna.cookie, { ...shot("settings-profile", "desktop-dark"), verdict: "skip", comment: "=HYPERLINK(\"x\")" });
// Ben: home down too, editor down on phone.
await cast(ben.cookie, { ...shot("home", "desktop-light"), verdict: "down", comment: "Zu viel Weißraum" });
await cast(ben.cookie, { ...shot("document-editor", "phone-light"), verdict: "down" });
// Distinct, increasing timestamps.
run("UPDATE votes SET created_at = 1700000000000 + id * 1000");

test("without VOTE_ADMIN_TOKEN the admin API does not exist; a wrong token is 401", async () => {
  delete process.env.VOTE_ADMIN_TOKEN;
  assert.equal((await admin("/api/admin/summary")).status, 404);
  process.env.VOTE_ADMIN_TOKEN = "short";
  assert.equal((await admin("/api/admin/summary", "short")).status, 404, "a too short token keeps it off");
  process.env.VOTE_ADMIN_TOKEN = ADMIN_TOKEN;
  assert.equal((await admin("/api/admin/summary", null)).status, 401);
  assert.equal((await admin("/api/admin/summary", `${ADMIN_TOKEN}x`)).status, 401);
  assert.equal((await admin("/api/admin/unknown")).status, 404);
  const r = await admin("/api/admin/summary");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("access-control-allow-origin"), null, "no CORS");
});

test("summary: gallery, totals, by group", async () => {
  const s = await body(await admin("/api/admin/summary"));
  assert.deepEqual(s.gallery, { generated: "2026-11-19T02:00:00.000Z", commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", commitShort: "a1b2c3d", version: "1.42.0", shots: 12 });
  assert.deepEqual(s.totals, { up: 1, down: 4, skip: 1, comments: 3, voters: 2, downVoters: 2 });
  assert.equal(s.latestVoteAt, new Date(1700000006000).toISOString());
  assert.deepEqual(s.byGroup, [
    { group: "Pages", up: 0, down: 3, skip: 0, voters: 2, downVoters: 2 },
    { group: "Documents & editor", up: 1, down: 1, skip: 0, voters: 2, downVoters: 1 },
    { group: "Settings", up: 0, down: 0, skip: 1, voters: 1, downVoters: 0 },
  ]);
});

test("votes: newest first, filters, cursor, current", async () => {
  const all = await body(await admin("/api/admin/votes"));
  assert.equal(all.votes.length, 6);
  assert.equal(all.nextCursor, null);
  assert.deepEqual(Object.keys(all.votes[0]).sort(), ["commit", "comment", "createdAt", "current", "galleryGenerated", "group", "hash", "id", "login", "scene", "title", "variant", "verdict", "version"].sort());
  assert.equal(all.votes[0].login, "ben");
  assert.equal(all.votes[0].current, true);
  assert.equal(all.votes[0].createdAt, new Date(1700000006000).toISOString(), "times as ISO strings");
  const down = await body(await admin("/api/admin/votes?verdict=down&group=Pages"));
  assert.equal(down.votes.length, 3);
  const page1 = await body(await admin("/api/admin/votes?limit=4"));
  assert.equal(page1.votes.length, 4);
  const page2 = await body(await admin(`/api/admin/votes?limit=4&cursor=${page1.nextCursor}`));
  assert.equal(page2.votes.length, 2);
  assert.equal(page2.nextCursor, null);
  assert.deepEqual([...page1.votes, ...page2.votes].map((v: { id: number }) => v.id), all.votes.map((v: { id: number }) => v.id));
  assert.equal((await body(await admin("/api/admin/votes?since=1700000005000"))).votes.length, 2);
  assert.equal((await body(await admin("/api/admin/votes?scene=home"))).votes.length, 3);
  assert.equal((await admin("/api/admin/votes?verdict=meh")).status, 400);
  assert.equal((await admin("/api/admin/votes?cursor=nope")).status, 400);
});

test("scenes: sorted by 👎, with voter counts and history per gallery run", async () => {
  const { scenes } = await body(await admin("/api/admin/scenes"));
  assert.deepEqual(scenes.map((s: { scene: string }) => s.scene), ["home", "document-editor", "settings-profile"]);
  const home = scenes[0];
  assert.equal(home.down, 3);
  assert.equal(home.comments, 2);
  assert.equal(home.lastVerdict, "down");
  assert.equal(home.current, true);
  assert.equal(home.lastVoteAt, new Date(1700000005000).toISOString());
  assert.equal(home.file, "shots/home--desktop-light.png", "the desktop-light image");
  assert.equal(home.thumb, "shots/home--desktop-light.png");
  // Distinct people, not votes: Anna's two 👎 on home count once.
  assert.deepEqual([home.voters, home.upVoters, home.downVoters, home.skipVoters], [2, 0, 2, 0]);
  const editor = scenes[1];
  assert.deepEqual([editor.voters, editor.upVoters, editor.downVoters, editor.skipVoters], [2, 1, 1, 0]);
  assert.deepEqual(home.history, [{ galleryGenerated: "2026-11-19T02:00:00.000Z", commitShort: "a1b2c3d", up: 0, down: 3 }]);
});

test("prompt: the 👎 scenes with variants, links, comments and the closing instruction", async () => {
  process.env.VOTE_TIME_ZONE = "Europe/Berlin";
  const { prompt, scenes } = await body(await admin("/api/admin/prompt?includeUp=1"));
  assert.equal(scenes, 2);
  assert.match(prompt, /^# Design-Feedback aus flowplan-vote \(Galerie vom 19\. Nov\. 2026, Commit a1b2c3d\)/);
  assert.match(prompt, /### Home\n\n- Szene: `home`\n- Gruppe: Pages\n- Varianten mit 👎: desktop-light, phone-dark\n- 👎: 2 von 2 Bewertenden \(100 %\)/);
  assert.match(prompt, /- Szene: `document-editor`[^#]*- 👎: 1 von 2 Bewertenden \(50 %\)/);
  assert.ok(prompt.indexOf("- Szene: `home`") < prompt.indexOf("- Szene: `document-editor`"), "ranked by share of voters");
  assert.ok(!/\b(anna|ben)\b/i.test(prompt), "no logins in the prompt");
  assert.ok(prompt.includes("desktop-light:\n\n> Die Seitenleiste"), "comments with the variant only");
  assert.ok(prompt.includes(`  - desktop-light: ${mock.base}/shots/home--desktop-light.png`));
  assert.ok(prompt.includes("> Die Seitenleiste ist zu breit.\n> Und der Kopf zu hoch."), "comments verbatim, quoted line by line");
  assert.ok(prompt.includes("> Zu viel Weißraum"));
  assert.ok(!prompt.includes("HYPERLINK"), "only comments of 👎 votes");
  assert.ok(!/## 👍 Gefällt \(nicht anfassen\)\n\n- `document-editor`/.test(prompt), "a scene with 👎 is not in the 👍 list");
  assert.ok(prompt.trimEnd().endsWith("Bitte wie bei /design-review: Screenshots ansehen, Befunde mit Vorschlägen auflisten und mich fragen, was umgesetzt wird – nichts ändern vor meinem OK."));
  const pages = await body(await admin("/api/admin/prompt?group=Settings"));
  assert.equal(pages.scenes, 0);
  assert.match(pages.prompt, /Keine Szene mit 👎/);
  assert.equal((await admin("/api/admin/prompt?scope=some")).status, 400);
});

test("scope=current leaves out images that changed since; scope=all keeps them", async () => {
  const shots = defaultShots().map((s) => (s.scene === "home" ? { ...s, hash: `${s.hash}-new` } : s));
  mock.setManifest(fakeManifest(shots, { generated: "2026-11-20T02:00:00.000Z", commit: "d".repeat(40), version: "1.43.0" }));
  await gallery(Date.now() + 2 * CACHE_MS);
  const current = await body(await admin("/api/admin/prompt?scope=current"));
  assert.equal(current.scenes, 1, "only document-editor");
  assert.match(current.prompt, /Commit ddddddd/);
  const all = await body(await admin("/api/admin/prompt?scope=all"));
  assert.equal(all.scenes, 2);
  const votes = await body(await admin("/api/admin/votes?scene=home"));
  assert.ok(votes.votes.every((v: { current: boolean }) => !v.current));
  // A scene no longer in the gallery has no image.
  mock.setManifest(fakeManifest(defaultShots().filter((x) => x.scene !== "settings-profile")));
  await gallery(Date.now() + 3 * CACHE_MS);
  const { scenes } = await body(await admin("/api/admin/scenes"));
  const gone = scenes.find((x: { scene: string }) => x.scene === "settings-profile");
  assert.equal("file" in gone || "thumb" in gone, false);
  mock.setManifest(fakeManifest(defaultShots()));
  await gallery(Date.now() + 4 * CACHE_MS);
});

test("export: JSON and CSV (spreadsheet formulas defused)", async () => {
  const j = await admin("/api/admin/export?format=json");
  assert.match(j.headers.get("content-disposition")!, /attachment; filename="flowplan-votes-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal((await body(j)).votes.length, 6);
  const c = await admin("/api/admin/export?format=csv");
  assert.equal(c.headers.get("content-type"), "text/csv; charset=utf-8");
  const csv = await c.text();
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "id,login,scene,group,title,variant,hash,galleryGenerated,commit,version,verdict,comment,createdAt,current");
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"Die Seitenleiste ist zu breit.\nUnd der Kopf zu hoch."'));
  assert.equal((await admin("/api/admin/export?format=xml")).status, 400);
});

test("prompt: 👎 scenes ranked by share of voters, not raw counts; open mode keeps logins out", async () => {
  process.env.VOTE_ALLOWED_LOGINS = "*";
  const carla = signIn("carla");
  const dirk = signIn("dirk");
  // home: 2 of 4 people 👎 (but 3 👎 votes); editor: 2 of 3 people 👎 (with Anna's 👍).
  await cast(carla.cookie, { ...shot("home", "desktop-dark"), verdict: "up" });
  await cast(dirk.cookie, { ...shot("home", "phone-light"), verdict: "up" });
  await cast(carla.cookie, { ...shot("document-editor", "desktop-dark"), verdict: "down", comment: "Toolbar zu voll" });
  const { prompt } = await body(await admin("/api/admin/prompt"));
  assert.match(prompt, /- Szene: `home`[^#]*- 👎: 2 von 4 Bewertenden \(50 %\)/);
  assert.match(prompt, /- Szene: `document-editor`[^#]*- 👎: 2 von 3 Bewertenden \(67 %\)/);
  assert.ok(prompt.indexOf("- Szene: `document-editor`") < prompt.indexOf("- Szene: `home`"), "the higher share first");
  assert.ok(!/\b(anna|ben|carla|dirk)\b/i.test(prompt), "no logins in the prompt");
  const { scenes } = await body(await admin("/api/admin/scenes"));
  const home = scenes.find((x: { scene: string }) => x.scene === "home");
  assert.deepEqual([home.voters, home.upVoters, home.downVoters], [4, 2, 2]);
  // The votes list still names the login (admin only).
  assert.equal((await body(await admin("/api/admin/votes?limit=1"))).votes[0].login, "carla");
});
