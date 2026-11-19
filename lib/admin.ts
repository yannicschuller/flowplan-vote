// The admin API for flowplan-admin (README "Admin API"): Bearer
// VOTE_ADMIN_TOKEN, compared in constant time; without a token configured
// every path answers 404. JSON only, no CORS headers (server to server).
import { all, one } from "./db";
import { HttpError, clientIp, json } from "./http";
import { config } from "./config";
import { safeEqual } from "./secret";
import { LIMITS, ipKey, limit } from "./rate-limit";
import { galleryOrNull, imageUrl, shotKey, type Gallery } from "./gallery";
import { isVerdict, type Verdict } from "./votes";
import { formatDate } from "./i18n";

type Row = {
  id: number;
  login: string;
  scene: string;
  grp: string;
  title: string;
  variant: string;
  hash: string;
  gallery_generated: string;
  commit: string;
  version: string;
  verdict: Verdict;
  comment: string;
  created_at: number;
};
const SELECT = `SELECT v.id,u.login,v.scene,v.grp,v.title,v.variant,v.hash,v.gallery_generated,v."commit",v.version,v.verdict,v.comment,v.created_at FROM votes v JOIN users u ON u.id=v.user_id`;

export function requireAdmin(request: Request) {
  const token = config.adminToken();
  if (!token) throw new HttpError(404, "not_found", "Not found.");
  const header = request.headers.get("authorization") || "";
  const sent = /^Bearer\s+(\S{1,500})$/i.exec(header)?.[1] || "";
  if (!sent || !safeEqual(sent, token)) {
    limit(`admin-fail:${ipKey(clientIp(request))}`, LIMITS.adminFailures);
    throw new HttpError(401, "unauthorized", "Bearer token missing or wrong.");
  }
}

// scene+variant → hash of the current gallery's image.
const currentHashes = (g: Gallery | null) => new Map((g?.shots ?? []).map((x) => [shotKey(x), x.hash]));
const isCurrent = (hashes: Map<string, string>, v: { scene: string; variant: string; hash: string }) => hashes.get(shotKey(v)) === v.hash;

const apiVote = (v: Row, hashes: Map<string, string>) => ({
  id: v.id,
  login: v.login,
  scene: v.scene,
  group: v.grp,
  title: v.title,
  variant: v.variant,
  hash: v.hash,
  galleryGenerated: v.gallery_generated,
  commit: v.commit,
  version: v.version,
  verdict: v.verdict,
  comment: v.comment,
  createdAt: iso(v.created_at),
  current: isCurrent(hashes, v),
});
// Times in admin answers are ISO strings (galleryGenerated already is one).
function iso(ms: number): string;
function iso(ms: number | null): string | null;
function iso(ms: number | null) {
  return ms === null ? null : new Date(ms).toISOString();
}

const galleryInfo = (g: Gallery | null) =>
  g ? { generated: g.generated, commit: g.commit, commitShort: g.commitShort, version: g.version, shots: g.shots.length } : null;

// GET /api/admin/summary
export async function adminSummary() {
  const g = await galleryOrNull();
  const totals = one<{ up: number; down: number; skip: number; comments: number; voters: number; latest: number | null }>(
    `SELECT COALESCE(SUM(verdict='up'),0) AS up, COALESCE(SUM(verdict='down'),0) AS down, COALESCE(SUM(verdict='skip'),0) AS skip,
            COALESCE(SUM(comment<>''),0) AS comments, COUNT(DISTINCT user_id) AS voters, MAX(created_at) AS latest FROM votes`,
  )!;
  const byGroup = all<{ group: string; up: number; down: number; skip: number }>(
    `SELECT grp AS "group", SUM(verdict='up') AS up, SUM(verdict='down') AS down, SUM(verdict='skip') AS skip FROM votes GROUP BY grp`,
  );
  // In the gallery's group order, unknown groups after them.
  const order = new Map((g?.groups ?? []).map((name, i) => [name, i]));
  byGroup.sort((a, b) => (order.get(a.group) ?? 1e6) - (order.get(b.group) ?? 1e6) || a.group.localeCompare(b.group));
  return {
    gallery: galleryInfo(g),
    totals: { up: totals.up, down: totals.down, skip: totals.skip, comments: totals.comments, voters: totals.voters },
    latestVoteAt: iso(totals.latest ?? null),
    byGroup,
  };
}

// GET /api/admin/votes?verdict=&group=&scene=&since=&limit=&cursor=
export async function adminVotes(params: URLSearchParams) {
  const where: string[] = [];
  const args: (string | number)[] = [];
  const verdict = params.get("verdict");
  if (verdict) {
    if (!isVerdict(verdict)) throw new HttpError(400, "invalid_verdict", "verdict must be up, down or skip.");
    where.push("v.verdict=?");
    args.push(verdict);
  }
  const group = params.get("group");
  if (group) {
    where.push("v.grp=?");
    args.push(group.slice(0, 100));
  }
  const scene = params.get("scene");
  if (scene) {
    where.push("v.scene=?");
    args.push(scene.slice(0, 200));
  }
  const since = params.get("since");
  if (since) {
    if (!/^\d{1,15}$/.test(since)) throw new HttpError(400, "invalid_since", "since must be milliseconds since 1970.");
    where.push("v.created_at>=?");
    args.push(Number(since));
  }
  const cursor = params.get("cursor");
  if (cursor) {
    const m = /^(\d{1,15})\.(\d{1,15})$/.exec(cursor);
    if (!m) throw new HttpError(400, "invalid_cursor", "Invalid cursor.");
    where.push("(v.created_at<? OR (v.created_at=? AND v.id<?))");
    args.push(Number(m[1]), Number(m[1]), Number(m[2]));
  }
  const limitParam = params.get("limit");
  const max = limitParam && /^\d{1,6}$/.test(limitParam) ? Math.min(1000, Math.max(1, Number(limitParam))) : 100;
  const rows = all<Row>(`${SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY v.created_at DESC, v.id DESC LIMIT ?`, ...args, max + 1);
  const page = rows.slice(0, max);
  const hashes = currentHashes(await galleryOrNull());
  const last = page[page.length - 1];
  return { votes: page.map((v) => apiVote(v, hashes)), nextCursor: rows.length > max && last ? `${last.created_at}.${last.id}` : null };
}

// GET /api/admin/scenes: per scene, newest votes deciding group, title and
// lastVerdict; `current` = the scene's latest vote is on an image the
// current gallery still shows; history = up/down per gallery run.
export async function adminScenes() {
  const rows = all<Row>(`${SELECT} ORDER BY v.created_at DESC, v.id DESC`);
  const g = await galleryOrNull();
  const hashes = currentHashes(g);
  // Images of the current gallery per scene: desktop-light, else the first variant.
  const images = new Map<string, { file: string; thumb: string }>();
  for (const x of g?.shots ?? []) {
    if (!images.has(x.scene) || x.variant === "desktop-light") images.set(x.scene, { file: x.file, thumb: x.thumb });
  }
  type Scene = {
    scene: string;
    group: string;
    title: string;
    up: number;
    down: number;
    skip: number;
    comments: number;
    lastVerdict: Verdict;
    lastVoteAt: number;
    current: boolean;
    runs: Map<string, { galleryGenerated: string; commitShort: string; up: number; down: number }>;
  };
  const scenes = new Map<string, Scene>();
  for (const v of rows) {
    let s = scenes.get(v.scene);
    if (!s) {
      s = { scene: v.scene, group: v.grp, title: v.title, up: 0, down: 0, skip: 0, comments: 0, lastVerdict: v.verdict, lastVoteAt: v.created_at, current: isCurrent(hashes, v), runs: new Map() };
      scenes.set(v.scene, s);
    }
    s[v.verdict]++;
    if (v.comment) s.comments++;
    let r = s.runs.get(v.gallery_generated);
    if (!r) {
      r = { galleryGenerated: v.gallery_generated, commitShort: v.commit.slice(0, 7), up: 0, down: 0 };
      s.runs.set(v.gallery_generated, r);
    }
    if (v.verdict === "up") r.up++;
    if (v.verdict === "down") r.down++;
  }
  const list = [...scenes.values()].map(({ runs, lastVoteAt, ...s }) => ({
    ...s,
    lastVoteAt: iso(lastVoteAt),
    // Relative to GALLERY_URL; left out when the scene is no longer in the gallery.
    ...(images.get(s.scene) ?? {}),
    history: [...runs.values()].sort((a, b) => a.galleryGenerated.localeCompare(b.galleryGenerated)),
  }));
  list.sort((a, b) => b.down - a.down || b.lastVoteAt.localeCompare(a.lastVoteAt));
  return { scenes: list };
}

// GET /api/admin/prompt?scope=current|all&group=&includeUp=0|1: a German
// instruction for Claude Code with the 👎 scenes, ready to paste.
export async function adminPrompt(params: URLSearchParams) {
  const scope = params.get("scope") || "current";
  if (scope !== "current" && scope !== "all") throw new HttpError(400, "invalid_scope", "scope must be current or all.");
  const group = (params.get("group") || "").slice(0, 100);
  const includeUp = params.get("includeUp") === "1";
  const g = await galleryOrNull();
  const hashes = currentHashes(g);
  const files = new Map((g?.shots ?? []).map((x) => [shotKey(x), x.file]));
  const rows = all<Row>(`${SELECT} WHERE v.verdict IN ('up','down')${group ? " AND v.grp=?" : ""} ORDER BY v.created_at ASC, v.id ASC`, ...(group ? [group] : []));
  const inScope = rows.filter((v) => scope === "all" || isCurrent(hashes, v));
  type Entry = { scene: string; group: string; title: string; variants: Set<string>; voters: Set<string>; comments: { login: string; variant: string; text: string }[] };
  const collect = (verdict: Verdict) => {
    const map = new Map<string, Entry>();
    for (const v of inScope) {
      if (v.verdict !== verdict) continue;
      let e = map.get(v.scene);
      if (!e) {
        e = { scene: v.scene, group: v.grp, title: v.title, variants: new Set(), voters: new Set(), comments: [] };
        map.set(v.scene, e);
      }
      e.group = v.grp;
      e.title = v.title;
      e.variants.add(v.variant);
      e.voters.add(v.login);
      if (v.comment) e.comments.push({ login: v.login, variant: v.variant, text: v.comment });
    }
    return map;
  };
  const down = collect("down");
  const up = collect("up");
  // Gallery order, then scene id.
  const order = new Map((g?.shots ?? []).map((x, i) => [x.scene, i] as const).reverse());
  const sorted = (m: Map<string, Entry>) => [...m.values()].sort((a, b) => (order.get(a.scene) ?? 1e9) - (order.get(b.scene) ?? 1e9) || a.scene.localeCompare(b.scene));

  const latest = rows[rows.length - 1];
  const generated = g?.generated || latest?.gallery_generated || "";
  const commitShort = g?.commitShort || latest?.commit.slice(0, 7) || "?";
  const date = generated && Number.isFinite(Date.parse(generated)) ? formatDate("de", Date.parse(generated), config.timeZone()) : "?";
  const galleryUrl = g?.url || config.galleryUrl();
  const link = (scene: string, variant: string) => {
    const file = files.get(shotKey({ scene, variant })) || `shots/${scene}--${variant}.png`;
    return imageUrl({ url: galleryUrl }, file);
  };
  const quote = (text: string) => text.split("\n").map((line) => `> ${line}`).join("\n");

  const lines: string[] = [`# Design-Feedback aus flowplan-vote (Galerie vom ${date}, Commit ${commitShort})`, ""];
  lines.push(
    scope === "current"
      ? "Bewertungen der aktuellen Galerie-Bilder" + (group ? ` – Gruppe „${group}“` : "") + ` (${galleryUrl}).`
      : "Alle Bewertungen, auch zu älteren Galerie-Bildern" + (group ? ` – Gruppe „${group}“` : "") + ` (${galleryUrl}).`,
    "",
  );
  const downList = sorted(down);
  if (!downList.length) lines.push("Keine Szene mit 👎.", "");
  else {
    lines.push(`## 👎 Gefällt nicht (${downList.length} ${downList.length === 1 ? "Szene" : "Szenen"})`, "");
    for (const e of downList) {
      lines.push(`### ${e.title || e.scene}`, "");
      lines.push(`- Szene: \`${e.scene}\``, `- Gruppe: ${e.group}`, `- Varianten mit 👎: ${[...e.variants].join(", ")}`, `- Stimmen: ${e.voters.size}`);
      lines.push(`- Bilder:`);
      for (const variant of e.variants) lines.push(`  - ${variant}: ${link(e.scene, variant)}`);
      if (e.comments.length) {
        lines.push("", "Kommentare:", "");
        for (const c of e.comments) lines.push(`${c.login} (${c.variant}):`, "", quote(c.text), "");
      } else lines.push("");
    }
  }
  if (includeUp) {
    const upList = sorted(up).filter((e) => !down.has(e.scene));
    if (upList.length) {
      lines.push("## 👍 Gefällt (nicht anfassen)", "");
      for (const e of upList) lines.push(`- \`${e.scene}\` – ${e.title || e.scene} (${e.group}; ${[...e.variants].join(", ")})`);
      lines.push("");
    }
  }
  lines.push(
    "Bitte wie bei /design-review: Screenshots ansehen, Befunde mit Vorschlägen auflisten und mich fragen, was umgesetzt wird – nichts ändern vor meinem OK.",
  );
  return { prompt: lines.join("\n"), scenes: downList.length };
}

// GET /api/admin/export?format=csv|json: every vote, newest first.
const CSV_FIELDS = ["id", "login", "scene", "group", "title", "variant", "hash", "galleryGenerated", "commit", "version", "verdict", "comment", "createdAt", "current"] as const;
// Cells starting with = + - @ (or a tab/CR) are prefixed with ' so a spreadsheet never runs them.
const csvCell = (value: unknown) => {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export async function adminExport(params: URLSearchParams) {
  const format = params.get("format") || "json";
  if (format !== "csv" && format !== "json") throw new HttpError(400, "invalid_format", "format must be csv or json.");
  const hashes = currentHashes(await galleryOrNull());
  const votes = all<Row>(`${SELECT} ORDER BY v.created_at DESC, v.id DESC`).map((v) => apiVote(v, hashes));
  const stamp = new Date().toISOString().slice(0, 10);
  if (format === "json")
    return json({ votes }, { headers: { "Content-Disposition": `attachment; filename="flowplan-votes-${stamp}.json"` } });
  const csv = [CSV_FIELDS.join(","), ...votes.map((v) => CSV_FIELDS.map((f) => csvCell(v[f])).join(","))].join("\r\n") + "\r\n";
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="flowplan-votes-${stamp}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function adminRoute(request: Request, name: string) {
  requireAdmin(request);
  const params = new URL(request.url).searchParams;
  switch (name) {
    case "summary":
      return json(await adminSummary());
    case "votes":
      return json(await adminVotes(params));
    case "scenes":
      return json(await adminScenes());
    case "prompt":
      return json(await adminPrompt(params));
    case "export":
      return adminExport(params);
    default:
      throw new HttpError(404, "not_found", "Not found.");
  }
}
