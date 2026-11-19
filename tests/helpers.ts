// Every test file gets its own data directory, a known environment and a
// fake gallery (tests/gallery-mock.ts) – never the network.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import { closeDb } from "../lib/db";
import { createSession, upsertUser, SESSION_COOKIE } from "../lib/auth";
import { forgetGallery } from "../lib/gallery";
import { startGalleryMock } from "./gallery-mock";

export const BASE = "http://localhost:3000";
export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef";

export async function setup() {
  const dir = mkdtempSync(join(tmpdir(), "vote-test-"));
  process.env.VOTE_DATA_DIR = dir;
  process.env.VOTE_URL = BASE;
  for (const name of ["VOTE_ALLOWED_LOGINS", "VOTE_GITHUB_API", "VOTE_GITHUB_CLIENT_ID", "VOTE_GITHUB_CLIENT_SECRET", "VOTE_ADMIN_TOKEN", "VOTE_TIME_ZONE"]) delete process.env[name];
  forgetGallery();
  const gallery = await startGalleryMock();
  after(async () => {
    closeDb();
    forgetGallery();
    await gallery.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, gallery };
}

let nextGithubId = 1000;
// A session straight in the database (the login must be in VOTE_ALLOWED_LOGINS to vote).
export function signIn(login: string) {
  const user = upsertUser({ id: nextGithubId++, login, name: login });
  const token = createSession(user.id);
  return { user, token, cookie: `${SESSION_COOKIE}=${token}` };
}
export function allow(...logins: string[]) {
  process.env.VOTE_ALLOWED_LOGINS = logins.join(", ");
}

export function req(path: string, init: RequestInit & { json?: unknown; form?: Record<string, string>; cookie?: string; origin?: string | null } = {}) {
  const headers = new Headers(init.headers);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  if (init.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = new URLSearchParams(init.form).toString();
  }
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.origin !== null && (init.method || "GET") !== "GET") headers.set("origin", init.origin ?? BASE);
  return new Request(BASE + path, { ...init, headers, body });
}
export const body = async (r: Response) => (await r.json()) as Record<string, any>;
