// The logic of every API endpoint, on plain Request and Response
// (app/api/** only forwards here; tests call these directly). Writing
// requests pass requireVoter() (Origin check + session of an allowed,
// not blocked login) first; the admin API is checked by its Bearer token (lib/admin.ts).
import { config, isAllowedLogin } from "./config";
import { HttpError, clientIp, cookie, int, isForm, json, readInput, redirect, safeNext, setCookie } from "./http";
import { RateLimitError, LIMITS, ipKey, limit } from "./rate-limit";
import {
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  accountOldEnough,
  authorizeUrl,
  clearSessionCookie,
  createSession,
  destroySession,
  githubProfile,
  requireSession,
  requireVoter,
  sessionCookie,
  upsertUser,
} from "./auth";
import { randomToken, safeEqual } from "./secret";
import { GalleryError, gallery } from "./gallery";
import { castVote, deck, deleteVote, progress, removeVoteOn, updateVote } from "./votes";
import { one } from "./db";

export { adminRoute } from "./admin";

export function healthRoute() {
  one("SELECT 1");
  return json({ service: "flowplan-vote", status: "ok" });
}

// ---- Sign-in ----

const STATE_PATH = "/api/auth";
export function loginRoute(request: Request) {
  const next = safeNext(new URL(request.url).searchParams.get("next"));
  if (!config.oauth()) return redirect("/login?error=github_off");
  const state = randomToken(24);
  // Only for the sign-in round trip (ten minutes), and only on the callback path.
  return redirect(authorizeUrl(state), [setCookie(OAUTH_STATE_COOKIE, `${state}|${next}`, { maxAge: 600, path: STATE_PATH })]);
}

export async function callbackRoute(request: Request) {
  const p = new URL(request.url).searchParams;
  const saved = cookie(request, OAUTH_STATE_COOKIE) || "";
  const bar = saved.indexOf("|");
  const state = bar > 0 ? saved.slice(0, bar) : "";
  const next = safeNext(bar > 0 ? saved.slice(bar + 1) : "/");
  const clear = setCookie(OAUTH_STATE_COOKIE, "", { maxAge: 0, path: STATE_PATH });
  const sent = p.get("state") || "";
  const code = p.get("code") || "";
  if (!state || !sent || !safeEqual(state, sent) || !code || code.length > 200) return redirect("/login?error=github_state", [clear]);
  try {
    limit(`signin:${ipKey(clientIp(request))}`, LIMITS.signIn);
    const profile = await githubProfile(code);
    // Refused logins (not on the list, blocked, account too young) get no
    // account and no session: nothing is stored about them.
    if (!isAllowedLogin(profile.login)) return redirect(`/login?error=not_allowed&login=${encodeURIComponent(profile.login)}`, [clear]);
    if (!accountOldEnough(profile.accountCreatedAt)) return redirect(`/login?error=account_too_new&login=${encodeURIComponent(profile.login)}`, [clear]);
    const user = upsertUser(profile);
    return redirect(next, [clear, sessionCookie(createSession(user.id))]);
  } catch (error) {
    const reason = error instanceof HttpError ? error.code : error instanceof RateLimitError ? "rate_limited" : "github_failed";
    if (reason === "github_failed" && !(error instanceof HttpError)) console.error(error);
    return redirect(`/login?error=${encodeURIComponent(reason)}`, [clear]);
  }
}

export async function logoutRoute(request: Request) {
  requireSession(request);
  destroySession(cookie(request, SESSION_COOKIE));
  if (isForm(request)) return redirect("/login?signedout=1", [clearSessionCookie()]);
  return json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}

// ---- Voting ----

async function currentGallery() {
  try {
    return await gallery();
  } catch (error) {
    if (error instanceof GalleryError) throw new HttpError(503, "gallery_unavailable", "Die Galerie ist gerade nicht erreichbar. / The gallery is not reachable right now.");
    throw error;
  }
}

const filterFrom = (params: URLSearchParams) => ({
  group: (params.get("group") || "").slice(0, 100) || undefined,
  variant: (params.get("variant") || "").slice(0, 50) || undefined,
  all: params.get("all") === "1",
});

// GET /api/deck?group=&variant=&all=1: the cards to vote on.
export async function deckRoute(request: Request) {
  const user = requireVoter(request, false);
  limit(`deck:${user.id}`, LIMITS.deckMinute);
  const g = await currentGallery();
  const filter = filterFrom(new URL(request.url).searchParams);
  return json({
    gallery: { generated: g.generated, commitShort: g.commitShort, version: g.version, groups: g.groups, variants: g.variants },
    filter,
    cards: deck(user, g, filter),
    progress: progress(user, g, filter),
  });
}

const voteLimits = (userId: number) => {
  limit(`vote-min:${userId}`, LIMITS.voteMinute);
  limit(`vote-hour:${userId}`, LIMITS.voteHour);
  limit(`vote-day:${userId}`, LIMITS.voteDay);
};

// POST /api/votes {scene, variant, hash, verdict, comment}: set the verdict on one image.
// DELETE /api/votes {scene, variant, hash}: remove it again (undo).
export async function votesRoute(request: Request) {
  const user = requireVoter(request);
  const input = await readInput(request, 16 * 1024);
  voteLimits(user.id);
  if (request.method === "DELETE") return json({ ok: true, ...removeVoteOn(user, input) });
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  await currentGallery();
  return json({ ok: true, ...(await castVote(user, input)) });
}

// PATCH /api/votes/<id> {verdict?, comment?} · DELETE /api/votes/<id>: "My votes".
export async function voteRoute(request: Request, idParam: string) {
  const user = requireVoter(request);
  const id = int(idParam);
  if (id === null) throw new HttpError(404, "not_found", "Vote not found.");
  voteLimits(user.id);
  if (request.method === "DELETE") return json({ ok: true, ...deleteVote(user, id) });
  if (request.method !== "PATCH") throw new HttpError(405, "method_not_allowed", "Method not allowed.");
  const input = await readInput(request, 16 * 1024);
  return json({ ok: true, ...updateVote(user, id, input) });
}
