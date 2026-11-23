// A scene's handling status in the admin API: done or declined (with a
// note) by the maintainer. The prompt leaves marked scenes out unless votes
// came in after the mark – then only those – and lists declined ones at the
// end so they are not proposed again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_TOKEN, allow, body, req, setup, signIn } from "./helpers";
import { handle } from "../lib/http";
import { adminRoute, votesRoute } from "../lib/routes";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION, migrate, run } from "../lib/db";

await setup();
process.env.VOTE_ADMIN_TOKEN = ADMIN_TOKEN;
process.env.VOTE_TIME_ZONE = "Europe/Berlin";
const admin = (path: string, json?: Record<string, unknown>, method = json ? "POST" : "GET") => {
  const name = new URL(path, "http://x").pathname.replace(/^\/api\/admin\//, "");
  return handle(() => adminRoute(req(path, { method, json, origin: null, headers: { authorization: `Bearer ${ADMIN_TOKEN}` } }), name));
};
const cast = (cookie: string, json: Record<string, unknown>) => handle(() => votesRoute(req("/api/votes", { method: "POST", json, cookie })));
const shot = (scene: string, variant: string) => ({ scene, variant, hash: `${scene}-${variant}-h1` });
const BY = "yannic@example.org";

allow("anna", "ben");
const anna = signIn("anna");
const ben = signIn("ben");
await cast(anna.cookie, { ...shot("home", "desktop-light"), verdict: "down", comment: "Seitenleiste zu breit" });
await cast(ben.cookie, { ...shot("home", "phone-dark"), verdict: "down", comment: "Kopf zu hoch" });
await cast(anna.cookie, { ...shot("document-editor", "desktop-light"), verdict: "down", comment: "Toolbar zu voll" });
await cast(ben.cookie, { ...shot("settings-profile", "desktop-light"), verdict: "down", comment: "Avatar zu groß" });
// Old votes, long before any mark.
run("UPDATE votes SET created_at = 1700000000000 + id * 1000");
const sceneOf = async (scene: string) => ((await body(await admin("/api/admin/scenes"))).scenes as Record<string, any>[]).find((s) => s.scene === scene)!;

test("validation: status, by, note, scene; reads stay GET-only", async () => {
  const bad = async (json: Record<string, unknown>, code: string, path = "/api/admin/scenes/home/status") => {
    const r = await admin(path, json);
    assert.equal(r.status, 400, JSON.stringify(json));
    assert.equal((await body(r)).error, code);
  };
  await bad({ status: "maybe", by: BY }, "invalid_status");
  await bad({ status: "done" }, "invalid_by");
  await bad({ status: "done", by: "x".repeat(201) }, "invalid_by");
  await bad({ status: "declined", by: BY, note: "n".repeat(301) }, "invalid_note");
  await bad({ status: "done", by: BY, scenes: [] }, "invalid_scenes", "/api/admin/scenes/status");
  await bad({ status: "done", by: BY, scenes: Array.from({ length: 501 }, (_, i) => `s${i}`) }, "invalid_scenes", "/api/admin/scenes/status");
  await bad({ status: "done", by: BY, scenes: ["home", ""] }, "invalid_scene", "/api/admin/scenes/status");
  assert.equal((await admin("/api/admin/scenes/home/status")).status, 405);
  assert.equal((await admin("/api/admin/scenes/home/other", {})).status, 404);
  assert.equal((await sceneOf("home")).status, null, "nothing stored by refused requests");
});

test("mark done: scenes carry the status; the prompt leaves the scene out until newer votes come", async () => {
  const r = await body(await admin("/api/admin/scenes/home/status", { status: "done", note: "Seitenleiste\n schmaler\u0007 gemacht", by: BY }));
  assert.equal(r.scene, "home");
  assert.equal(r.changed, true);
  assert.equal(r.status.status, "done");
  assert.equal(r.status.note, "Seitenleiste schmaler gemacht", "one line, control characters out");
  assert.equal(r.status.markedBy, BY);
  const markedAt = Date.parse(r.status.markedAt);
  assert.ok(Math.abs(markedAt - Date.now()) < 5000);

  const home = await sceneOf("home");
  assert.deepEqual(home.status, r.status);
  assert.deepEqual(home.sinceMark, { up: 0, down: 0, skip: 0, comments: 0 });
  assert.equal((await sceneOf("document-editor")).status, null);
  assert.equal((await sceneOf("document-editor")).sinceMark, null);

  const p = await body(await admin("/api/admin/prompt?scope=all"));
  assert.equal(p.scenes, 2);
  assert.deepEqual(p.sceneIds.sort(), ["document-editor", "settings-profile"]);
  assert.equal(p.leftOut, 1);
  assert.deepEqual(p.declined, []);
  assert.ok(!p.prompt.includes("`home`"), "a handled scene is left out");
  assert.ok(!p.prompt.includes("Seitenleiste zu breit"));

  // A new 👎 after the mark (the mark moved a little back, so it is surely older): the scene comes back with only that vote and the mark's date and note.
  run("UPDATE scene_status SET marked_at = marked_at - 50");
  await cast(anna.cookie, { ...shot("home", "desktop-dark"), verdict: "down", comment: "Im Dark Mode zu dunkel" });
  const again = await body(await admin("/api/admin/prompt?scope=all"));
  assert.equal(again.scenes, 3);
  assert.ok(again.sceneIds.includes("home"));
  assert.equal(again.leftOut, 0);
  assert.match(again.prompt, /- Szene: `home`[^#]*- Varianten mit 👎: desktop-dark\n- 👎: 1 von 1 Bewertenden \(100 %\)\n- Zuletzt als erledigt markiert am \d{1,2}\. \w+\.? \d{4} \(Seitenleiste schmaler gemacht\) – hier nur die Stimmen danach/);
  assert.ok(again.prompt.includes("> Im Dark Mode zu dunkel"));
  assert.ok(!again.prompt.includes("Seitenleiste zu breit"), "votes before the mark stay out");
  assert.ok(!again.prompt.includes("Kopf zu hoch"));
  assert.ok(!again.prompt.includes(BY), "who marked never goes into the prompt");
  assert.deepEqual((await sceneOf("home")).sinceMark, { up: 0, down: 1, skip: 0, comments: 1 });

  // Marking again moves the mark: the new vote is handled too.
  const re = await body(await admin("/api/admin/scenes/home/status", { status: "done", by: BY }));
  assert.equal(re.status.note, "");
  assert.ok(Date.parse(re.status.markedAt) >= markedAt);
  assert.ok(!(await body(await admin("/api/admin/prompt?scope=all"))).sceneIds.includes("home"));
});

test("declined scenes: left out and listed at the end so they are not proposed again", async () => {
  const r = await body(await admin("/api/admin/scenes/settings-profile/status", { status: "declined", note: "Avatar bleibt so groß", by: BY }));
  assert.equal(r.status.status, "declined");
  const p = await body(await admin("/api/admin/prompt?scope=all"));
  assert.deepEqual(p.sceneIds, ["document-editor"]);
  assert.deepEqual(p.declined, ["settings-profile"]);
  assert.match(p.prompt, /## Nicht erneut vorschlagen \(abgelehnt\)\n\n- `settings-profile` – Settings · Profile – Avatar bleibt so groß\n/);
  assert.ok(!p.prompt.includes("Avatar zu groß"), "no votes of a declined scene");
  assert.ok(p.prompt.indexOf("Nicht erneut vorschlagen") < p.prompt.indexOf("Bitte wie bei /design-review"));
  // With a group filter only that group's declined scenes.
  const other = await body(await admin("/api/admin/prompt?scope=all&group=Pages"));
  assert.deepEqual(other.declined, []);
  assert.ok(!other.prompt.includes("Nicht erneut vorschlagen"));
});

test("bulk: mark every scene of a prompt done in one call; open resets", async () => {
  const p = await body(await admin("/api/admin/prompt?scope=all"));
  const r = await body(await admin("/api/admin/scenes/status", { scenes: [...p.sceneIds, ...p.sceneIds], status: "done", by: BY }));
  assert.deepEqual(r.scenes, p.sceneIds, "deduplicated");
  assert.equal(r.updated, p.sceneIds.length);
  assert.equal(r.status, "done");
  assert.ok(r.markedAt);
  const after = await body(await admin("/api/admin/prompt?scope=all"));
  assert.equal(after.scenes, 0);
  assert.match(after.prompt, /Keine Szene mit 👎/);
  assert.deepEqual(after.declined, ["settings-profile"], "a declined scene stays declined");

  const open = await body(await admin("/api/admin/scenes/document-editor/status", { status: "open" }));
  assert.deepEqual([open.changed, open.status], [true, null]);
  const twice = await body(await admin("/api/admin/scenes/document-editor/status", { status: "open" }));
  assert.equal(twice.changed, false);
  assert.ok((await body(await admin("/api/admin/prompt?scope=all"))).sceneIds.includes("document-editor"), "open again: every vote counts");
  const bulkOpen = await body(await admin("/api/admin/scenes/status", { scenes: ["home", "settings-profile", "nope"], status: "open" }));
  assert.equal(bulkOpen.updated, 2);
  assert.equal(bulkOpen.markedAt, null);
  assert.equal((await sceneOf("home")).status, null);
});

test("scene ids with odd characters are taken as one id (URL-encoded)", async () => {
  const r = await body(await admin(`/api/admin/scenes/${encodeURIComponent("db/table view")}/status`, { status: "declined", by: BY }));
  assert.equal(r.scene, "db/table view");
  await admin(`/api/admin/scenes/${encodeURIComponent("db/table view")}/status`, { status: "open" });
});

test("migration 3 adds the scene status table to an existing database", () => {
  const conn = new DatabaseSync(":memory:");
  conn.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version(version) VALUES(2);");
  conn.exec(MIGRATIONS[0]);
  conn.exec(MIGRATIONS[1]);
  migrate(conn);
  assert.equal(SCHEMA_VERSION, 3);
  assert.equal((conn.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 3);
  conn.exec("INSERT INTO scene_status(scene,status,note,marked_at,marked_by) VALUES('home','done','',1,'x')");
  assert.throws(() => conn.exec("INSERT INTO scene_status(scene,status,marked_at) VALUES('x','maybe',1)"), /CHECK/);
  conn.close();
});
