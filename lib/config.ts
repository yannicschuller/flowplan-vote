// Settings from the environment. Read on every call (not at import time), so
// tests can set them before the first use. Secrets come only from here.
import { resolve } from "node:path";
import { DEFAULT_TIME_ZONE } from "./i18n";

const text = (name: string) => (process.env[name] || "").trim();

// The admin token must be long enough to be a secret; a shorter one keeps
// the admin API switched off (with a log line).
export const MIN_ADMIN_TOKEN = 24;
let warnedShortToken = false;

export const config = {
  // Where the SQLite database and the generated key live (one volume).
  dataDir: () => resolve(/*turbopackIgnore: true*/ text("VOTE_DATA_DIR") || "./data"),
  // The public address, without a trailing slash: OAuth callback, Origin
  // check for writing requests, Secure cookies.
  publicUrl: () => (text("VOTE_URL") || "http://localhost:3000").replace(/\/+$/, ""),
  publicOrigin: () => new URL(config.publicUrl()).origin,
  https: () => config.publicUrl().startsWith("https://"),
  // Who may vote: GitHub logins, comma-separated, case-insensitive. Empty
  // means nobody (the sign-in page says so).
  allowedLogins: () =>
    new Set(
      text("VOTE_ALLOWED_LOGINS")
        .split(",")
        .map((login) => login.trim().toLowerCase())
        .filter(Boolean),
    ),
  // The nightly UI gallery (manifest.json and the images).
  galleryUrl: () => (text("GALLERY_URL") || "https://gallery.flowplan.org").replace(/\/+$/, ""),
  galleryOrigin: () => {
    try {
      return new URL(config.galleryUrl()).origin;
    } catch {
      return "";
    }
  },
  // GitHub's REST API; tests point it at a local mock server (the OAuth
  // code exchange then goes there too).
  githubApi: () => (text("VOTE_GITHUB_API") || "https://api.github.com").replace(/\/+$/, ""),
  githubWeb: () => (text("VOTE_GITHUB_API") ? config.githubApi() : "https://github.com"),
  // The GitHub App's user authorization (sign-in only).
  oauth: () => {
    const clientId = text("VOTE_GITHUB_CLIENT_ID");
    const clientSecret = text("VOTE_GITHUB_CLIENT_SECRET");
    return clientId && clientSecret ? { clientId, clientSecret } : null;
  },
  // Bearer token of the admin API (flowplan-admin); unset = API off (404).
  adminToken: () => {
    const token = text("VOTE_ADMIN_TOKEN");
    if (token && token.length < MIN_ADMIN_TOKEN) {
      if (!warnedShortToken) console.error(`VOTE_ADMIN_TOKEN is shorter than ${MIN_ADMIN_TOKEN} characters – the admin API stays off.`);
      warnedShortToken = true;
      return "";
    }
    return token;
  },
  // IANA time zone for dates and times on the pages and in the prompt (default Europe/Berlin).
  timeZone: () => validTimeZone(text("VOTE_TIME_ZONE")),
};

// Checked once per value; an unknown zone falls back to Europe/Berlin with a log line.
const checkedZones = new Map<string, string>();
export function validTimeZone(value: string): string {
  if (!value) return DEFAULT_TIME_ZONE;
  let zone = checkedZones.get(value);
  if (zone) return zone;
  try {
    zone = new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    console.error(`VOTE_TIME_ZONE "${value}" is not a known IANA time zone – using ${DEFAULT_TIME_ZONE}.`);
    zone = DEFAULT_TIME_ZONE;
  }
  checkedZones.set(value, zone);
  return zone;
}

export const isAllowedLogin = (login: string | null | undefined) => !!login && config.allowedLogins().has(login.toLowerCase());
