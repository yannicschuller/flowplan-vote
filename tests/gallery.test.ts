import { test } from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers";
import { defaultShots, fakeManifest, fakeShot } from "./gallery-mock";
import { CACHE_MS, findShot, forgetGallery, gallery, parseManifest } from "../lib/gallery";
import { contentSecurityPolicy } from "../proxy";

const { gallery: mock } = await setup();

test("the manifest is parsed: failed shots, foreign paths and duplicates are left out", () => {
  const shots = [
    ...defaultShots(),
    { ...fakeShot("evil", "Pages", "Evil", "desktop-light"), file: "https://evil.example/x.png" },
    { ...fakeShot("dots", "Pages", "Dots", "desktop-light"), file: "../secret.png" },
    fakeShot("home", "Pages", "Home again", "desktop-light", "other-hash"),
  ];
  const g = parseManifest(fakeManifest(shots), "https://gallery.example");
  assert.equal(g.shots.length, 12, "3 scenes × 4 variants");
  assert.ok(!g.shots.some((s) => s.scene === "broken" || s.scene === "evil" || s.scene === "dots"));
  assert.equal(g.shots.find((s) => s.scene === "home" && s.variant === "desktop-light")!.title, "Home", "first one wins");
  assert.equal(g.commitShort, "a1b2c3d");
  assert.deepEqual(g.groups, ["Pages", "Documents & editor", "Settings"], "the manifest's order, only groups with shots");
  assert.deepEqual(g.variants, ["desktop-light", "desktop-dark", "phone-light", "phone-dark"]);
  assert.throws(() => parseManifest({ nope: 1 }, "x"));
});

test("the gallery is cached for ten minutes and a stale copy survives a failure", async () => {
  forgetGallery();
  const before = mock.requests();
  const t0 = Date.now();
  const first = await gallery(t0);
  assert.equal(first.shots.length, 12);
  await gallery(t0 + 60_000);
  assert.equal(mock.requests(), before + 1, "served from the cache");
  mock.setStatus(503);
  const stale = await gallery(t0 + 2 * CACHE_MS);
  assert.equal(stale, first, "the last good copy");
  assert.equal(mock.requests(), before + 2);
  mock.setStatus(200);
  forgetGallery();
  mock.setStatus(500);
  await assert.rejects(() => gallery(), /answered 500/);
  mock.setStatus(200);
  forgetGallery();
});

test("a vote finds its image in the current or a recent run", async () => {
  forgetGallery();
  await gallery();
  assert.ok(await findShot("home", "phone-dark", "home-phone-dark-h1"));
  assert.equal(await findShot("home", "phone-dark", "nope"), null);
  // A new run with a changed image: the old hash still resolves (recent runs).
  mock.setManifest(fakeManifest([fakeShot("home", "Pages", "Home", "phone-dark", "h2")], { generated: "2026-11-20T02:00:00.000Z", commit: "b".repeat(40), version: "1.43.0" }));
  forgetGallery();
  await gallery();
  assert.ok(await findShot("home", "phone-dark", "h2"));
  mock.setManifest(fakeManifest(defaultShots()));
  forgetGallery();
});

test("the CSP allows images from the gallery's origin only, and no inline scripts", () => {
  const csp = contentSecurityPolicy("abc", false, true, "https://gallery.flowplan.org");
  assert.match(csp, /img-src 'self' data: https:\/\/gallery\.flowplan\.org;/);
  assert.match(csp, /script-src 'self' 'nonce-abc' 'strict-dynamic';/);
  assert.match(csp, /style-src 'self' 'nonce-abc';/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(csp, /upgrade-insecure-requests/);
});
