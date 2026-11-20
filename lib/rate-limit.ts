// Fixed-window rate limits kept in the database (they survive restarts).
// Keys hold a user id or ipKey(), a daily HMAC of the address – never an
// IP address itself.
import { hmac } from "./secret";
import { one, run } from "./db";

export class RateLimitError extends Error {
  constructor(public retryAfter: number) {
    super("rate limited");
  }
}

// Counts one hit; throws RateLimitError once `max` hits fell into the window.
export function hit(key: string, max: number, windowSeconds: number, at = Date.now()) {
  const windowMs = windowSeconds * 1000;
  const row = one<{ window_start: number; count: number }>("SELECT window_start,count FROM rate_limits WHERE key=?", key);
  if (!row || at - row.window_start >= windowMs) {
    run("INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window_start=excluded.window_start,count=1", key, at);
    return;
  }
  if (row.count >= max) throw new RateLimitError(Math.ceil((row.window_start + windowMs - at) / 1000));
  run("UPDATE rate_limits SET count=count+1 WHERE key=?", key);
}

// The limits (per signed-in user; sign-in and wrong admin tokens per hashed address).
export const LIMITS = {
  voteMinute: [180, 60],
  // A full pass through the gallery (~400 images) plus undos and comments
  // fits in an hour; a script hammering the API does not.
  voteHour: [1000, 3600],
  voteDay: [5000, 86_400],
  deckMinute: [120, 60],
  signIn: [30, 3600],
  // Wrong admin tokens, per hashed address.
  adminFailures: [30, 600],
} as const;
export const limit = (key: string, [max, seconds]: readonly [number, number], at = Date.now()) => hit(key, max, seconds, at);

// The visitor's address as a daily HMAC: enough to tell repeated requests
// apart, useless for recognising anyone the next day.
export function ipKey(ip: string, at = Date.now()) {
  const day = Math.floor(at / 86_400_000);
  return hmac("ip", `${day}:${ip}`).slice(0, 22);
}

export function cleanup(at = Date.now()) {
  run("DELETE FROM rate_limits WHERE window_start < ?", at - 2 * 86_400_000);
  run("DELETE FROM sessions WHERE expires_at < ?", at);
}
