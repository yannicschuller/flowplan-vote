// Starts the production (standalone) build for the browser tests: a fresh
// data directory, a fake gallery (tests/gallery-mock.ts) on its own port,
// and a test session created directly in the database (no GitHub, no real
// account). Run by playwright.config.ts as its web server; `npm run build`
// must have run.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { startGalleryMock } from "../gallery-mock";

const root = resolve(import.meta.dirname, "..", "..");
const port = Number(process.env.PORT || 3124);
const dataDir = process.env.VOTE_DATA_DIR!;
const gallery = await startGalleryMock({ listen: Number(process.env.GALLERY_PORT || port + 1) });
process.env.VOTE_URL = `http://127.0.0.1:${port}`;
process.env.VOTE_ALLOWED_LOGINS = "yannicschuller, tester, rita";
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const { createSession, upsertUser } = await import("../../lib/auth");
const { closeDb } = await import("../../lib/db");
const voter = upsertUser({ id: 9001, login: "tester", name: "Tester" });
const outsider = upsertUser({ id: 9002, login: "outsider", name: "Outsider" });
// For the screenshots (tests/browser/screens.spec.ts): a deck of its own.
const shooter = upsertUser({ id: 9003, login: "yannicschuller", name: "Yannic" });
// For the reset test: a vote the maintainer dismisses through the admin API.
const rita = upsertUser({ id: 9004, login: "rita", name: "Rita" });
writeFileSync(
  join(dataDir, "browser-test.json"),
  JSON.stringify({ voter: createSession(voter.id), outsider: createSession(outsider.id), shooter: createSession(shooter.id), rita: createSession(rita.id), gallery: gallery.base }),
);
closeDb();

// The standalone server needs the static files next to it.
const standalone = join(root, ".next", "standalone");
cpSync(join(root, ".next", "static"), join(standalone, ".next", "static"), { recursive: true });
cpSync(join(root, "public"), join(standalone, "public"), { recursive: true });
const server = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", join(standalone, "server.js")], {
  stdio: "inherit",
  env: { ...process.env, PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", GALLERY_URL: gallery.base },
});
const stop = () => {
  server.kill("SIGTERM");
  void gallery.close();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
server.on("exit", (code) => process.exit(code ?? 0));
