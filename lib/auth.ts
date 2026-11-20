// Sign-in only with GitHub, through the GitHub App's user authorization
// (OAuth). The user's token is used once to read GET /user and then
// dropped. Who gets an account and a session: in list mode the logins in
// VOTE_ALLOWED_LOGINS, in open mode (VOTE_ALLOWED_LOGINS=*) every GitHub
// account at least VOTE_MIN_ACCOUNT_AGE_DAYS old; never a login in
// VOTE_BLOCKED_LOGINS. Nothing is stored about anyone refused.
// Sessions are random tokens in an httpOnly cookie; the database keeps only
// their SHA-256.
import { now, one, run } from "./db";
import { randomToken, sha256 } from "./secret";
import { HttpError, cookie, requireSameOrigin, setCookie } from "./http";
import { config, isAllowedLogin } from "./config";
import { githubFetch } from "./github";

export const SESSION_COOKIE = "fv_session";
export const OAUTH_STATE_COOKIE = "fv_oauth";
export const SESSION_DAYS = 30;

export type User = { id: number; github_id: number; login: string; name: string; created_at: number };
// `allowed` follows VOTE_ALLOWED_LOGINS and VOTE_BLOCKED_LOGINS on every
// request: a login taken off the list (or blocked, or list mode switched
// back on) loses access at once, even with a valid session.
export type SessionUser = User & { allowed: boolean };

export function upsertUser(profile: { id: number; login: string; name?: string | null }): User {
  const at = now();
  run(
    "INSERT INTO users(github_id,login,name,created_at,last_login_at) VALUES(?,?,?,?,?) ON CONFLICT(github_id) DO UPDATE SET login=excluded.login,name=excluded.name,last_login_at=excluded.last_login_at",
    profile.id,
    profile.login,
    (profile.name || "").slice(0, 100),
    at,
    at,
  );
  return one<User>("SELECT id,github_id,login,name,created_at FROM users WHERE github_id=?", profile.id)!;
}

export function createSession(userId: number) {
  const token = randomToken();
  const at = now();
  run("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)", sha256(token), userId, at, at + SESSION_DAYS * 86_400_000);
  return token;
}
export const sessionCookie = (token: string) => setCookie(SESSION_COOKIE, token, { maxAge: SESSION_DAYS * 86_400 });
export const clearSessionCookie = () => setCookie(SESSION_COOKIE, "", { maxAge: 0 });

export function userForSessionToken(token: string | undefined | null): SessionUser | null {
  if (!token || token.length > 100) return null;
  const row = one<User & { expires_at: number }>(
    "SELECT u.id,u.github_id,u.login,u.name,u.created_at,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?",
    sha256(token),
  );
  if (!row || row.expires_at < now()) return null;
  const { expires_at: _expires, ...user } = row;
  return { ...user, allowed: isAllowedLogin(user.login) };
}
export function destroySession(token: string | undefined) {
  if (token) run("DELETE FROM sessions WHERE token_hash=?", sha256(token));
}

export const currentUser = (request: Request) => userForSessionToken(cookie(request, SESSION_COOKIE));

// A request of the voting UI: a valid session of an allowed login; writing
// requests also from the same origin (CSRF).
export function requireVoter(request: Request, writing = true): SessionUser {
  if (writing) requireSameOrigin(request);
  const user = currentUser(request);
  if (!user) throw new HttpError(401, "signed_out", "Bitte melde dich an. / Please sign in.");
  if (!user.allowed) throw new HttpError(403, "not_allowed", "Kein Zugang. / No access.");
  return user;
}
// Signing out works for everyone with a session.
export function requireSession(request: Request): SessionUser {
  requireSameOrigin(request);
  const user = currentUser(request);
  if (!user) throw new HttpError(401, "signed_out", "Bitte melde dich an. / Please sign in.");
  return user;
}

// ---- GitHub OAuth (user-to-server) ----

export const callbackUrl = () => `${config.publicUrl()}/api/auth/callback`;

export function authorizeUrl(state: string) {
  const oauth = config.oauth();
  if (!oauth) throw new HttpError(404, "github_off", "GitHub sign-in is not configured.");
  const url = new URL(`${config.githubWeb()}/login/oauth/authorize`);
  url.searchParams.set("client_id", oauth.clientId);
  url.searchParams.set("redirect_uri", callbackUrl());
  url.searchParams.set("state", state);
  return url.toString();
}

// Open mode only: is the GitHub account at least VOTE_MIN_ACCOUNT_AGE_DAYS
// old? A missing or unreadable creation date counts as too young.
export function accountOldEnough(accountCreatedAt: number | null, at = now()) {
  if (!config.openVoting()) return true;
  const days = config.minAccountAgeDays();
  if (days <= 0) return true;
  return accountCreatedAt !== null && at - accountCreatedAt >= days * 86_400_000;
}

// Exchanges the code on the server and reads the user (GET /user, which
// also carries the account's created_at – no extra request, no extra
// scope); the token is not kept.
export async function githubProfile(code: string) {
  const oauth = config.oauth();
  if (!oauth) throw new HttpError(404, "github_off", "GitHub sign-in is not configured.");
  const tokenResponse = await githubFetch(`${config.githubWeb()}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: oauth.clientId, client_secret: oauth.clientSecret, code, redirect_uri: callbackUrl() }),
  });
  const tokenData = (await tokenResponse.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenResponse.ok || !tokenData.access_token) throw new HttpError(400, "github_failed", "GitHub sign-in failed.");
  const userResponse = await githubFetch(`${config.githubApi()}/user`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: "application/vnd.github+json" },
  });
  const profile = (await userResponse.json().catch(() => ({}))) as { id?: number; login?: string; name?: string | null; created_at?: unknown };
  if (!userResponse.ok || typeof profile.id !== "number" || typeof profile.login !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(profile.login))
    throw new HttpError(400, "github_failed", "GitHub sign-in failed.");
  const created = typeof profile.created_at === "string" ? Date.parse(profile.created_at) : NaN;
  // accountCreatedAt is only used for the age check and never stored.
  return { id: profile.id, login: profile.login, name: profile.name ?? "", accountCreatedAt: Number.isFinite(created) ? created : null };
}
