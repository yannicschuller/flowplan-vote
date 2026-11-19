// The nightly UI gallery (GALLERY_URL, default https://gallery.flowplan.org):
// its manifest.json is fetched on the server and cached for ten minutes.
// Images are shown straight from the gallery (CSP img-src allows its origin).
import { config } from "./config";

export type Shot = {
  scene: string;
  group: string;
  title: string;
  path: string;
  // desktop-light | desktop-dark | phone-light | phone-dark
  variant: string;
  // Relative to GALLERY_URL.
  file: string;
  thumb: string;
  width: number;
  height: number;
  hash: string;
};
export type Gallery = {
  url: string;
  generated: string;
  commit: string;
  commitShort: string;
  version: string;
  groups: string[];
  variants: string[];
  // Only shots with an image and without an error, in the gallery's order.
  shots: Shot[];
};

export const CACHE_MS = 10 * 60_000;
// After a failed fetch, try again at the earliest after this long (the stale copy is served meanwhile).
const RETRY_MS = 60_000;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 20 * 1024 * 1024;

export class GalleryError extends Error {}

const s = (v: unknown, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);
// Paths relative to the gallery only: no scheme, no "..", no leading slash.
const relative = (v: unknown) => {
  const p = s(v, 300);
  return p && !/^[a-z]+:|^\/|\\|(^|\/)\.\.(\/|$)/i.test(p) ? p : "";
};

export function parseManifest(data: unknown, url: string): Gallery {
  if (!data || typeof data !== "object") throw new GalleryError("manifest.json is not an object");
  const m = data as Record<string, unknown>;
  if (!Array.isArray(m.shots)) throw new GalleryError("manifest.json has no shots");
  const shots: Shot[] = [];
  const seen = new Set<string>();
  for (const raw of m.shots) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (r.error) continue;
    const shot: Shot = {
      scene: s(r.scene, 200),
      group: s(r.group, 100),
      title: s(r.title, 300),
      path: s(r.path, 500),
      variant: s(r.variant, 50),
      file: relative(r.file),
      thumb: relative(r.thumb) || relative(r.file),
      width: n(r.width),
      height: n(r.height),
      hash: s(r.hash, 128),
    };
    if (!shot.scene || !shot.variant || !shot.file || !shot.hash) continue;
    const key = `${shot.scene}\u0000${shot.variant}`;
    if (seen.has(key)) continue;
    seen.add(key);
    shots.push(shot);
  }
  const order = (list: unknown, found: string[]) => {
    const given = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    return [...given.filter((g) => found.includes(g)), ...found.filter((f) => !given.includes(f))];
  };
  const commit = s(m.commit, 64);
  return {
    url,
    generated: s(m.generated, 40),
    commit,
    commitShort: s(m.commitShort, 16) || commit.slice(0, 7),
    version: s(m.version, 40),
    groups: order(m.groups, [...new Set(shots.map((x) => x.group))]),
    variants: order(m.variants, [...new Set(shots.map((x) => x.variant))]),
    shots,
  };
}

type Cache = { url: string; gallery: Gallery | null; fetchedAt: number; failedAt: number; error: string; pending: Promise<Gallery> | null; recent: Gallery[] };
const holder = globalThis as unknown as { voteGallery?: Cache };
const cache = (): Cache => {
  const url = config.galleryUrl();
  if (!holder.voteGallery || holder.voteGallery.url !== url)
    holder.voteGallery = { url, gallery: null, fetchedAt: 0, failedAt: 0, error: "", pending: null, recent: [] };
  return holder.voteGallery;
};
export const forgetGallery = () => {
  holder.voteGallery = undefined;
};

async function fetchManifest(url: string): Promise<Gallery> {
  let response: Response;
  try {
    response = await fetch(`${url}/manifest.json`, { headers: { Accept: "application/json", "User-Agent": "flowplan-vote" }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch (error) {
    throw new GalleryError(`manifest.json: ${(error as Error)?.name === "TimeoutError" ? "timed out" : (error as Error)?.message || "network error"}`);
  }
  if (!response.ok) throw new GalleryError(`manifest.json answered ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BYTES) throw new GalleryError("manifest.json is too large");
  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    throw new GalleryError("manifest.json is not JSON");
  }
  return parseManifest(data, url);
}

// The current gallery: from the cache while it is younger than ten minutes,
// else fetched (one request at a time). When the fetch fails, the last good
// copy is served; without one, GalleryError.
export async function gallery(at = Date.now()): Promise<Gallery> {
  const c = cache();
  if (c.gallery && at - c.fetchedAt < CACHE_MS) return c.gallery;
  if (c.gallery && c.failedAt && at - c.failedAt < RETRY_MS) return c.gallery;
  if (!c.gallery && c.failedAt && at - c.failedAt < 5_000) throw new GalleryError(c.error);
  c.pending ??= fetchManifest(c.url)
    .then((g) => {
      c.gallery = g;
      c.fetchedAt = Date.now();
      c.failedAt = 0;
      c.error = "";
      // The last few runs, so a vote sent just before a new gallery still finds its image.
      c.recent = [g, ...c.recent.filter((r) => r.generated !== g.generated || r.commit !== g.commit)].slice(0, 3);
      return g;
    })
    .catch((error: Error) => {
      c.failedAt = Date.now();
      c.error = error.message;
      console.error(`Gallery: ${error.message}`);
      if (c.gallery) return c.gallery;
      throw error instanceof GalleryError ? error : new GalleryError(error.message);
    })
    .finally(() => {
      c.pending = null;
    });
  return c.pending;
}

// The gallery or null (pages and admin API answers that work without it).
export async function galleryOrNull(): Promise<Gallery | null> {
  try {
    return await gallery();
  } catch {
    return null;
  }
}

// The shot (with its run) for a vote: in the current run or one of the last ones.
export async function findShot(scene: string, variant: string, hash: string): Promise<{ shot: Shot; run: Gallery } | null> {
  await gallery();
  for (const run of cache().recent) {
    const shot = run.shots.find((x) => x.scene === scene && x.variant === variant && x.hash === hash);
    if (shot) return { shot, run };
  }
  return null;
}

export const imageUrl = (g: { url: string }, file: string) => `${g.url}/${file.split("/").map(encodeURIComponent).join("/")}`;
export const shotKey = (x: { scene: string; variant: string }) => `${x.scene}\u0000${x.variant}`;
