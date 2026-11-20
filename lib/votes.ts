// Votes: one verdict (up, down, skip) per person and image, optionally with
// a short comment. The deck is what a person has not voted on yet: shots
// without a vote on their current image (never voted, or the pixels changed
// since the last vote on that scene and variant).
import { all, now, one, run, transaction } from "./db";
import { hmac } from "./secret";
import { HttpError, str } from "./http";
import { findShot, imageUrl, shotKey, type Gallery } from "./gallery";
import type { SessionUser } from "./auth";

export const VERDICTS = ["up", "down", "skip"] as const;
export type Verdict = (typeof VERDICTS)[number];
export const isVerdict = (v: unknown): v is Verdict => typeof v === "string" && (VERDICTS as readonly string[]).includes(v);
export const MAX_COMMENT = 500;

export type VoteRow = {
  id: number;
  user_id: number;
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

// One card of the deck, as the voting UI gets it.
export type Card = {
  scene: string;
  group: string;
  title: string;
  path: string;
  variant: string;
  hash: string;
  image: string;
  thumb: string;
  width: number;
  height: number;
  // This person's vote on exactly this image ("show all"), if any.
  vote: { verdict: Verdict; comment: string } | null;
  // This person voted on an earlier image of this scene and variant.
  changed: { verdict: Verdict; at: number } | null;
};

export type DeckFilter = { group?: string; variant?: string; all?: boolean };

// Comments: trimmed, at most 500 characters, no control characters except line breaks.
export function cleanComment(v: unknown): string {
  const text = str(v, 2000)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "")
    .trim();
  if ([...text].length > MAX_COMMENT) throw new HttpError(400, "comment_too_long", `Höchstens ${MAX_COMMENT} Zeichen. / At most ${MAX_COMMENT} characters.`);
  return text;
}

export function deck(user: { id: number }, g: Gallery, filter: DeckFilter = {}): Card[] {
  const votes = all<Pick<VoteRow, "scene" | "variant" | "hash" | "verdict" | "comment" | "created_at">>(
    "SELECT scene,variant,hash,verdict,comment,created_at FROM votes WHERE user_id=? ORDER BY created_at DESC, id DESC",
    user.id,
  );
  const exact = new Map<string, (typeof votes)[number]>();
  const latest = new Map<string, (typeof votes)[number]>();
  for (const v of votes) {
    const key = shotKey(v);
    exact.set(`${key}\u0000${v.hash}`, exact.get(`${key}\u0000${v.hash}`) ?? v);
    if (!latest.has(key)) latest.set(key, v);
  }
  const cards: Card[] = [];
  for (const shot of g.shots) {
    if (filter.group && shot.group !== filter.group) continue;
    if (filter.variant && shot.variant !== filter.variant) continue;
    const mine = exact.get(`${shotKey(shot)}\u0000${shot.hash}`);
    if (mine && !filter.all) continue;
    const last = latest.get(shotKey(shot));
    cards.push({
      scene: shot.scene,
      group: shot.group,
      title: shot.title,
      path: shot.path,
      variant: shot.variant,
      hash: shot.hash,
      image: imageUrl(g, shot.file),
      thumb: imageUrl(g, shot.thumb),
      width: shot.width,
      height: shot.height,
      vote: mine ? { verdict: mine.verdict, comment: mine.comment } : null,
      changed: !mine && last ? { verdict: last.verdict, at: last.created_at } : null,
    });
  }
  // A random order per person and gallery run instead of the gallery's
  // order: stable across reloads and undo (keyed, not Math.random), new for
  // every nightly run and different for every person.
  const rank = (c: Card) => hmac("deck", `${user.id}\u0000${g.generated}\u0000${shotKey(c)}\u0000${c.hash}`);
  return cards.map((c) => [rank(c), c] as const).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([, c]) => c);
}

// Counts for the progress: shots in the filter, and how many of them are voted on (current image).
export function progress(user: { id: number }, g: Gallery, filter: DeckFilter = {}) {
  const shots = g.shots.filter((x) => (!filter.group || x.group === filter.group) && (!filter.variant || x.variant === filter.variant));
  const voted = new Set(all<{ scene: string; variant: string; hash: string }>("SELECT scene,variant,hash FROM votes WHERE user_id=?", user.id).map((r) => `${shotKey(r)}\u0000${r.hash}`));
  return { total: shots.length, voted: shots.filter((x) => voted.has(`${shotKey(x)}\u0000${x.hash}`)).length };
}

const bounded = (v: unknown, name: string, max: number) => {
  const value = str(v, max + 1);
  if (!value || value.length > max) throw new HttpError(400, `invalid_${name}`, `${name} missing or too long.`);
  return value;
};

// Sets this person's verdict on one image (replacing an earlier one on the
// same image). Answers the vote and what it replaced, for "undo".
export async function castVote(user: SessionUser, input: Record<string, unknown>) {
  const scene = bounded(input.scene, "scene", 200);
  const variant = bounded(input.variant, "variant", 50);
  const hash = bounded(input.hash, "hash", 128);
  if (!isVerdict(input.verdict)) throw new HttpError(400, "invalid_verdict", "verdict must be up, down or skip.");
  const verdict = input.verdict;
  const comment = cleanComment(input.comment);
  const found = await findShot(scene, variant, hash);
  if (!found) throw new HttpError(409, "unknown_shot", "Dieses Bild ist nicht (mehr) in der Galerie. / This image is not in the gallery (any more).");
  const { shot, run: g } = found;
  return transaction(() => {
    const previous = one<VoteRow>("SELECT * FROM votes WHERE user_id=? AND scene=? AND variant=? AND hash=?", user.id, scene, variant, hash);
    const at = now();
    run(
      `INSERT INTO votes(user_id,scene,grp,title,variant,hash,gallery_generated,"commit",version,verdict,comment,created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id,scene,variant,hash) DO UPDATE SET verdict=excluded.verdict, comment=excluded.comment, created_at=excluded.created_at`,
      user.id,
      scene,
      shot.group,
      shot.title,
      variant,
      hash,
      g.generated,
      g.commit,
      g.version,
      verdict,
      comment,
      at,
    );
    const vote = one<VoteRow>("SELECT * FROM votes WHERE user_id=? AND scene=? AND variant=? AND hash=?", user.id, scene, variant, hash)!;
    return { vote: publicVote(vote), previous: previous ? { verdict: previous.verdict, comment: previous.comment } : null };
  });
}

// Removes this person's vote on one image (undo of a first vote).
export function removeVoteOn(user: SessionUser, input: Record<string, unknown>) {
  const scene = bounded(input.scene, "scene", 200);
  const variant = bounded(input.variant, "variant", 50);
  const hash = bounded(input.hash, "hash", 128);
  const result = run("DELETE FROM votes WHERE user_id=? AND scene=? AND variant=? AND hash=?", user.id, scene, variant, hash);
  return { deleted: Number(result.changes) };
}

function ownVote(user: SessionUser, id: number) {
  const vote = one<VoteRow>("SELECT * FROM votes WHERE id=? AND user_id=?", id, user.id);
  if (!vote) throw new HttpError(404, "not_found", "Bewertung nicht gefunden. / Vote not found.");
  return vote;
}

// "My votes": change the verdict and/or the comment of an own vote.
export function updateVote(user: SessionUser, id: number, input: Record<string, unknown>) {
  const vote = ownVote(user, id);
  const verdict = input.verdict === undefined ? vote.verdict : input.verdict;
  if (!isVerdict(verdict)) throw new HttpError(400, "invalid_verdict", "verdict must be up, down or skip.");
  const comment = input.comment === undefined ? vote.comment : cleanComment(input.comment);
  if (verdict !== vote.verdict || comment !== vote.comment) run("UPDATE votes SET verdict=?, comment=?, created_at=? WHERE id=?", verdict, comment, now(), id);
  return { vote: publicVote(ownVote(user, id)) };
}
export function deleteVote(user: SessionUser, id: number) {
  ownVote(user, id);
  run("DELETE FROM votes WHERE id=?", id);
  return { deleted: 1 };
}

export const publicVote = (v: VoteRow) => ({
  id: v.id,
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
  createdAt: v.created_at,
});
export type PublicVote = ReturnType<typeof publicVote>;

// "My votes": everything this person voted, newest first, with the current
// gallery's thumbnail where the scene and variant still exist.
export type MyVote = PublicVote & { thumb: string; image: string; current: boolean };
export function myVotes(user: { id: number }, g: Gallery | null): MyVote[] {
  const shots = new Map((g?.shots ?? []).map((x) => [shotKey(x), x]));
  return all<VoteRow>("SELECT * FROM votes WHERE user_id=? ORDER BY created_at DESC, id DESC LIMIT 5000", user.id).map((v) => {
    const shot = shots.get(shotKey(v));
    return {
      ...publicVote(v),
      thumb: g && shot ? imageUrl(g, shot.thumb) : "",
      image: g && shot ? imageUrl(g, shot.file) : "",
      current: !!shot && shot.hash === v.hash,
    };
  });
}
