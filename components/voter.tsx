"use client";
// The voting screen: a stack of gallery screenshots, one at a time.
// Swipe right 👍, left 👎, up to skip (pointer events: touch and mouse), or
// use the buttons and keys (→ ← ↓, K comment, Z undo, Enter full image,
// ? help). Votes go out at once through the queue (vote-queue.ts), which
// keeps them while offline. Every position is set through CSS custom
// properties from script – never a style attribute (CSP).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "./i18n";
import { VoteQueue, imageKey, type QueueState } from "./vote-queue";
import { variantLabel, variantParts, verdictLabel } from "@/lib/labels";
import { errorMessage } from "@/lib/notices";
import type { Card, Verdict } from "@/lib/votes";

type Filter = { group: string; variant: string; all: boolean };
type Props = {
  cards: Card[];
  progress: { total: number; voted: number };
  filter: Filter;
  groups: string[];
  variants: string[];
  galleryLabel: string;
  login: string;
};
type Mine = { verdict: Verdict; comment: string } | null;
type HistoryEntry = { index: number; card: Card; verdict: Verdict; comment: string; before: Mine };
type Fly = "right" | "left" | "up";

const FLY_MS = 260;
const flyOf: Record<Verdict, Fly> = { up: "right", down: "left", skip: "up" };
const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

export function Voter(props: Props) {
  const t = useT();
  const [cards, setCards] = useState(props.cards);
  const [filter, setFilter] = useState(props.filter);
  const [total, setTotal] = useState(props.filter.all ? props.cards.length : props.progress.total);
  const [index, setIndexState] = useState(0);
  // The card being voted on now – ahead of `index` while the previous card is still flying out.
  const indexRef = useRef(0);
  const setIndex = (i: number) => {
    indexRef.current = i;
    setIndexState(i);
  };
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // What this person has on each image (from the server, then as changed here).
  const mine = useRef(new Map<string, Mine>());
  const [comment, setComment] = useState("");
  const [commentFor, setCommentFor] = useState<"current" | "last" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [notice, setNotice] = useState<{ kind: "err" | "warn"; text: string } | null>(null);
  const [queueState, setQueueState] = useState<QueueState>({ pending: 0, offline: false, error: "" });
  const queue = useRef<VoteQueue | null>(null);
  const stack = useRef<HTMLDivElement>(null);
  const topCard = useRef<HTMLElement>(null);
  const commentField = useRef<HTMLTextAreaElement>(null);
  const helpDialog = useRef<HTMLDialogElement>(null);
  const imageDialog = useRef<HTMLDialogElement>(null);
  const flying = useRef<{ timer: ReturnType<typeof setTimeout>; done: () => void } | null>(null);

  const card = cards[index] as Card | undefined;
  const position = Math.min(total, total - cards.length + index + 1);
  const done = total - cards.length + index;

  useEffect(() => {
    for (const c of cards) if (!mine.current.has(imageKey(c))) mine.current.set(imageKey(c), c.vote);
  }, [cards]);

  // The queue: one per signed-in person; flushes on "online".
  useEffect(() => {
    const q = new VoteQueue(props.login);
    queue.current = q;
    const off = q.subscribe(setQueueState);
    const online = () => void q.flush();
    window.addEventListener("online", online);
    void q.flush();
    return () => {
      off();
      window.removeEventListener("online", online);
      q.dispose();
    };
  }, [props.login]);

  useEffect(() => {
    if (queueState.error) {
      setNotice({ kind: "err", text: errorMessage(queueState.error, t) });
      queue.current?.clearError();
    }
  }, [queueState.error, t]);

  // ---- Deck ----

  const loadDeck = useCallback(async (next: Filter) => {
    setLoading(true);
    setNotice(null);
    const params = new URLSearchParams();
    if (next.group) params.set("group", next.group);
    if (next.variant) params.set("variant", next.variant);
    if (next.all) params.set("all", "1");
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/?${query}` : "/");
    try {
      // Changes still waiting go out first, so the new deck knows them.
      await queue.current?.flush();
      const response = await fetch(`/api/deck${query ? `?${query}` : ""}`, { headers: { Accept: "application/json" } });
      const body = (await response.json().catch(() => ({}))) as { cards?: Card[]; progress?: { total: number }; error?: string };
      if (!response.ok || !body.cards) throw new Error(body.error || "failed");
      mine.current.clear();
      setCards(body.cards);
      setTotal(next.all ? body.cards.length : body.progress?.total ?? body.cards.length);
      setIndex(0);
      setHistory([]);
    } catch (error) {
      setNotice({ kind: "err", text: errorMessage((error as Error).message, t) });
    } finally {
      setLoading(false);
    }
  }, [t]);

  const changeFilter = (patch: Partial<Filter>) => {
    const next = { ...filter, ...patch };
    setFilter(next);
    void loadDeck(next);
  };

  // ---- Motion (CSS custom properties on the top card) ----

  const setVars = (el: HTMLElement | null, dx: number, dy: number, w = 1, h = 1) => {
    if (!el) return;
    el.style.setProperty("--dx", `${dx}px`);
    el.style.setProperty("--dy", `${dy}px`);
    el.style.setProperty("--rot", `${Math.max(-18, Math.min(18, (dx / w) * 16))}deg`);
    const tx = Math.max(80, Math.min(160, w * 0.25));
    const ty = Math.max(80, Math.min(180, h * 0.2));
    const up = -dy > Math.abs(dx) ? Math.min(1, -dy / ty) : 0;
    el.style.setProperty("--drag-like", String(dx > 0 && !up ? Math.min(1, dx / tx) : 0));
    el.style.setProperty("--drag-nope", String(dx < 0 && !up ? Math.min(1, -dx / tx) : 0));
    el.style.setProperty("--drag-skip", String(up));
  };

  const finishFlight = () => {
    const f = flying.current;
    if (!f) return;
    clearTimeout(f.timer);
    flying.current = null;
    f.done();
  };

  // ---- Voting ----

  const vote = (verdict: Verdict) => {
    finishFlight();
    const i = indexRef.current;
    const c = cards[i];
    if (!c || loading) return;
    const key = imageKey(c);
    const before = mine.current.has(key) ? mine.current.get(key)! : c.vote;
    const text = commentFor === "current" ? comment.trim() : "";
    mine.current.set(key, { verdict, comment: text });
    queue.current?.push({ scene: c.scene, variant: c.variant, hash: c.hash, action: "set", verdict, comment: text });
    setHistory((h) => [...h.slice(-49), { index: i, card: c, verdict, comment: text, before }]);
    if (commentFor === "current") {
      setComment("");
      setCommentFor(null);
    }
    setNotice(null);
    const next = cards[i + 1];
    setAnnouncement(
      `${verdictLabel(t, verdict)}: ${c.title}${text ? ` (${t("mit Kommentar", "with comment")})` : ""}. ` +
        (next ? `${t("Nächstes", "Next")}: ${next.title}, ${variantLabel(t, next.variant)}.` : t("Alles bewertet.", "All done.")),
    );
    const advance = () => {
      const el = topCard.current;
      el?.classList.remove("flying", "fly-right", "fly-left", "fly-up");
      setIndex(i + 1);
    };
    indexRef.current = i + 1;
    const el = topCard.current;
    if (!el || reducedMotion()) return advance();
    const fly = flyOf[verdict];
    el.classList.remove("dragging", "settling");
    el.classList.add("flying", `fly-${fly}`);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (fly === "right") setVars(el, w * 1.3 + 200, readVar(el, "--dy"), w, h);
    else if (fly === "left") setVars(el, -(w * 1.3 + 200), readVar(el, "--dy"), w, h);
    else setVars(el, readVar(el, "--dx"), -(h * 1.2 + 200), w, h);
    flying.current = { timer: setTimeout(finishFlight, FLY_MS), done: advance };
  };

  const undo = () => {
    finishFlight();
    const last = history[history.length - 1];
    if (!last) return;
    const key = imageKey(last.card);
    mine.current.set(key, last.before);
    if (last.before) queue.current?.push({ scene: last.card.scene, variant: last.card.variant, hash: last.card.hash, action: "set", ...last.before });
    else queue.current?.push({ scene: last.card.scene, variant: last.card.variant, hash: last.card.hash, action: "delete" });
    setHistory((h) => h.slice(0, -1));
    setIndex(last.index);
    if (last.comment) {
      setComment(last.comment);
      setCommentFor("current");
    } else if (commentFor === "last") setCommentFor(null);
    setAnnouncement(t(`Rückgängig: ${last.card.title} ist wieder da.`, `Undone: ${last.card.title} is back.`));
  };

  // A comment for the card on top (sent with the verdict) or for the last vote (sent at once).
  const openComment = (target: "current" | "last") => {
    if (target === "current" && !cards[indexRef.current]) return;
    if (target === "last") {
      const last = history[history.length - 1];
      if (!last) return;
      setComment(last.comment);
    } else if (commentFor === "last") setComment("");
    setCommentFor(target);
    requestAnimationFrame(() => commentField.current?.focus());
  };
  const saveLastComment = () => {
    const last = history[history.length - 1];
    if (!last) return;
    const text = comment.trim();
    mine.current.set(imageKey(last.card), { verdict: last.verdict, comment: text });
    queue.current?.push({ scene: last.card.scene, variant: last.card.variant, hash: last.card.hash, action: "set", verdict: last.verdict, comment: text });
    setHistory((h) => [...h.slice(0, -1), { ...last, comment: text }]);
    setComment("");
    setCommentFor(null);
    setAnnouncement(t("Kommentar gespeichert.", "Comment saved."));
  };
  const closeComment = () => {
    if (commentFor === "last") setComment("");
    setCommentFor(null);
    stack.current?.focus();
  };

  const openImage = () => {
    finishFlight();
    if (!cards[indexRef.current]) return;
    imageDialog.current?.showModal();
  };

  // ---- Keys ----

  const onKey = useRef<(e: KeyboardEvent) => void>(() => {});
  onKey.current = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.target === commentField.current && commentFor === "last") {
        e.preventDefault();
        saveLastComment();
      }
      return;
    }
    if (helpDialog.current?.open || imageDialog.current?.open) return;
    if (typing(e.target)) {
      // Esc leaves the field; the comment stays and goes with the next verdict (an empty one closes).
      if (e.key === "Escape" && e.target === commentField.current) {
        e.preventDefault();
        if (!comment.trim()) closeComment();
        else stack.current?.focus();
      }
      return;
    }
    const onControl = e.target instanceof HTMLElement && /^(BUTTON|A|SUMMARY)$/.test(e.target.tagName);
    switch (e.key) {
      case "ArrowRight":
        e.preventDefault();
        return vote("up");
      case "ArrowLeft":
        e.preventDefault();
        return vote("down");
      case "ArrowDown":
        e.preventDefault();
        return vote("skip");
      case "k":
      case "K":
        e.preventDefault();
        return openComment("current");
      case "z":
      case "Z":
        e.preventDefault();
        return undo();
      case "Enter":
        if (onControl) return;
        e.preventDefault();
        return openImage();
      case "?":
        e.preventDefault();
        return helpDialog.current?.showModal();
    }
  };
  useEffect(() => {
    const listener = (e: KeyboardEvent) => onKey.current(e);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  // ---- Dragging ----

  const drag = useRef<{ id: number; x: number; y: number; t: number; dx: number; dy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || !e.isPrimary || flying.current) return;
    if ((e.target as HTMLElement).closest("button, a")) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el.classList.remove("settling");
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), dx: 0, dy: 0 };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    d.dx = e.clientX - d.x;
    d.dy = e.clientY - d.y;
    const el = e.currentTarget;
    if (Math.abs(d.dx) + Math.abs(d.dy) > 4) el.classList.add("dragging");
    setVars(el, d.dx, Math.min(d.dy, 40), el.offsetWidth, el.offsetHeight);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    const el = e.currentTarget;
    el.classList.remove("dragging");
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const tx = Math.max(80, Math.min(160, w * 0.25));
    const ty = Math.max(80, Math.min(180, h * 0.2));
    const ms = Math.max(1, performance.now() - d.t);
    const vx = d.dx / ms;
    const vy = d.dy / ms;
    const upwards = -d.dy > Math.abs(d.dx);
    if (e.type === "pointerup") {
      if (upwards && (-d.dy > ty || (vy < -0.7 && -d.dy > 40))) return vote("skip");
      if (!upwards && (d.dx > tx || (vx > 0.7 && d.dx > 40))) return vote("up");
      if (!upwards && (d.dx < -tx || (vx < -0.7 && d.dx < -40))) return vote("down");
    }
    // Not far enough: spring back.
    el.classList.add("settling");
    setVars(el, 0, 0, w, h);
  };

  // ---- Preloading: the two cards after the next one are in the stack already; one more here. ----
  useEffect(() => {
    const c = cards[index + 3];
    if (!c) return;
    const img = new Image();
    img.decoding = "async";
    img.src = c.image;
  }, [cards, index]);

  // A new card on top starts at rest.
  useEffect(() => {
    const el = topCard.current;
    if (!el) return;
    el.classList.remove("dragging", "settling", "flying", "fly-right", "fly-left", "fly-up");
    setVars(el, 0, 0);
  }, [index, cards]);

  const visible = useMemo(() => cards.slice(index, index + 3), [cards, index]);
  const lastEntry = history[history.length - 1];
  const percent = total ? Math.round((done / total) * 100) : 100;
  const current = card ? mine.current.get(imageKey(card)) ?? card.vote : null;

  return (
    <div className="voter">
      <div className="voter-bar">
        <details className="filters">
          <summary className="button small ghost">
            <FilterIcon />
            <span>{t("Filter", "Filter")}</span>
            {(filter.group || filter.variant || filter.all) && <span className="dot" aria-label={t("aktiv", "active")} />}
          </summary>
          <div className="filter-fields">
            <label>
              <span>{t("Gruppe", "Group")}</span>
              <select value={filter.group} onChange={(e) => changeFilter({ group: e.target.value })} disabled={loading}>
                <option value="">{t("Alle Gruppen", "All groups")}</option>
                {props.groups.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("Variante", "Variant")}</span>
              <select value={filter.variant} onChange={(e) => changeFilter({ variant: e.target.value })} disabled={loading}>
                <option value="">{t("Alle Varianten", "All variants")}</option>
                {props.variants.map((v) => (
                  <option key={v} value={v}>
                    {variantLabel(t, v)}
                  </option>
                ))}
              </select>
            </label>
            <label className="switch">
              <input type="checkbox" role="switch" checked={filter.all} onChange={(e) => changeFilter({ all: e.target.checked })} disabled={loading} />
              <span>{t("Alle zeigen (auch bewertete)", "Show all (voted too)")}</span>
            </label>
          </div>
        </details>
        <span className="gallery-label muted small">{props.galleryLabel}</span>
        <span className="spacer" />
        {queueState.pending > 0 && (
          <span className={`sync-state small ${queueState.offline ? "offline" : ""}`} role="status">
            {queueState.offline
              ? t(`Offline – ${queueState.pending} warten`, `Offline – ${queueState.pending} waiting`)
              : t("Speichert …", "Saving …")}
          </span>
        )}
        <div className="progress" aria-label={t(`Bild ${position} von ${total}`, `Image ${position} of ${total}`)} role="group">
          <span className="progress-count" aria-hidden="true">
            {card ? position : total} <span className="muted">/ {total}</span>
          </span>
          <span className="progress-track" aria-hidden="true">
            <ProgressFill percent={percent} />
          </span>
        </div>
        <button type="button" className="button small ghost icon-only" onClick={() => helpDialog.current?.showModal()} aria-label={t("Tastenkürzel (?)", "Keyboard shortcuts (?)")} title={t("Tastenkürzel (?)", "Keyboard shortcuts (?)")}>
          ?
        </button>
      </div>

      {notice && (
        <p className={`notice ${notice.kind} voter-notice`} role="alert">
          {notice.text}{" "}
          <button type="button" className="link-button" onClick={() => setNotice(null)}>
            {t("Schließen", "Dismiss")}
          </button>
        </p>
      )}

      <div className={`stack${loading ? " loading" : ""}`} ref={stack} tabIndex={-1} aria-busy={loading}>
        {card ? (
          visible
            .map((c, depth) => {
              const key = imageKey(c);
              const { device } = variantParts(c.variant);
              return (
                <article
                  key={key}
                  ref={depth === 0 ? topCard : undefined}
                  className={`vote-card depth-${depth} ${device || "desktop"}`}
                  aria-hidden={depth > 0 ? true : undefined}
                  aria-roledescription={depth === 0 ? t("Karte", "card") : undefined}
                  aria-label={depth === 0 ? `${c.title}, ${variantLabel(t, c.variant)}, ${t(`${position} von ${total}`, `${position} of ${total}`)}` : undefined}
                  onPointerDown={depth === 0 ? onPointerDown : undefined}
                  onPointerMove={depth === 0 ? onPointerMove : undefined}
                  onPointerUp={depth === 0 ? onPointerUp : undefined}
                  onPointerCancel={depth === 0 ? onPointerUp : undefined}
                  onDoubleClick={depth === 0 ? openImage : undefined}
                >
                  <div className="shot">
                    <ShotImage
                      src={c.image}
                      alt={depth === 0 ? t(`Screenshot: ${c.title} (${variantLabel(t, c.variant)})`, `Screenshot: ${c.title} (${variantLabel(t, c.variant)})`) : ""}
                      width={c.width}
                      height={c.height}
                      priority={depth === 0}
                      failedText={t("Bild konnte nicht geladen werden", "Image could not be loaded")}
                    />
                    <span className="stamp like" aria-hidden="true">
                      👍 {t("Gut", "Like")}
                    </span>
                    <span className="stamp nope" aria-hidden="true">
                      👎 {t("Nicht gut", "Nope")}
                    </span>
                    <span className="stamp skip" aria-hidden="true">
                      {t("Überspringen", "Skip")}
                    </span>
                    {depth === 0 && (
                      <button type="button" className="zoom" onClick={openImage} aria-label={t("Ganzes Bild öffnen (Enter)", "Open full image (Enter)")} title={t("Ganzes Bild (Enter)", "Full image (Enter)")}>
                        <ZoomIcon />
                      </button>
                    )}
                  </div>
                  <div className="card-meta">
                    <div className="card-title">
                      <h2>{c.title}</h2>
                      <span className="scene mono">{c.scene}</span>
                    </div>
                    <div className="chips">
                      <span className="chip">{c.group}</span>
                      <span className={`chip variant ${variantParts(c.variant).theme}`}>
                        <DeviceIcon device={device} />
                        {variantLabel(t, c.variant)}
                      </span>
                      {depth === 0 && current && (
                        <span className={`chip verdict ${current.verdict}`}>
                          {t("Deine Bewertung", "Your vote")}: {current.verdict === "up" ? "👍" : current.verdict === "down" ? "👎" : t("übersprungen", "skipped")}
                        </span>
                      )}
                      {depth === 0 && !current && c.changed && (
                        <span className="chip changed" title={t("Das Bild hat sich seit deiner letzten Bewertung geändert.", "The image changed since your last vote.")}>
                          {t("Geändert", "Changed")} · {t("vorher", "before")} {c.changed.verdict === "up" ? "👍" : c.changed.verdict === "down" ? "👎" : "–"}
                        </span>
                      )}
                    </div>
                  </div>
                </article>
              );
            })
            .reverse()
        ) : (
          <div className="done-state">
            <div className="done-mark" aria-hidden="true">
              ✓
            </div>
            <h2>{filter.group || filter.variant ? t("In diesem Filter ist alles bewertet", "Everything in this filter is voted on") : t("Alles bewertet – die nächste Galerie kommt heute Nacht", "All done – the next gallery arrives tonight")}</h2>
            <p className="muted">
              {history.length
                ? t(`${history.length} Bewertungen in dieser Runde. Danke!`, `${history.length} votes this round. Thank you!`)
                : t("Hier gibt es gerade nichts zu bewerten.", "Nothing to vote on right now.")}
            </p>
            <div className="row center">
              {!filter.all && (
                <button type="button" className="button" onClick={() => changeFilter({ all: true })}>
                  {t("Alle zeigen", "Show all")}
                </button>
              )}
              {(filter.group || filter.variant) && (
                <button type="button" className="button" onClick={() => changeFilter({ group: "", variant: "" })}>
                  {t("Filter zurücksetzen", "Reset filter")}
                </button>
              )}
              <Link className="button primary" href="/mine">
                {t("Meine Bewertungen", "My votes")}
              </Link>
            </div>
          </div>
        )}
      </div>

      {commentFor && (
        <div className="comment-panel">
          <label htmlFor="vote-comment" className="comment-label">
            {commentFor === "last" && lastEntry
              ? t(`Kommentar zu deiner letzten Bewertung (${lastEntry.card.title})`, `Comment on your last vote (${lastEntry.card.title})`)
              : t("Kommentar – wird mit deiner Bewertung gespeichert", "Comment – saved with your vote")}
          </label>
          <textarea
            id="vote-comment"
            ref={commentField}
            rows={2}
            maxLength={500}
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("Was fällt dir auf? (optional, kurz)", "What do you notice? (optional, short)")}
          />
          <div className="comment-actions">
            <span className="muted small">{comment.length} / 500</span>
            <span className="spacer" />
            <button type="button" className="button small ghost" onClick={closeComment}>
              {commentFor === "last" ? t("Abbrechen", "Cancel") : t("Schließen", "Close")}
            </button>
            {commentFor === "last" && (
              <button type="button" className="button small primary" onClick={saveLastComment}>
                {t("Speichern", "Save")}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="actions" role="group" aria-label={t("Bewertung", "Vote")}>
        <button type="button" className="act undo" onClick={undo} disabled={!history.length} aria-label={t("Letzte Bewertung rückgängig (Z)", "Undo last vote (Z)")} title={t("Rückgängig (Z)", "Undo (Z)")}>
          <UndoIcon />
          <kbd>Z</kbd>
        </button>
        <button type="button" className="act nope" onClick={() => vote("down")} disabled={!card || loading} aria-label={t("Gefällt mir nicht (Pfeil links)", "Dislike (left arrow)")} title={t("Gefällt mir nicht (←)", "Dislike (←)")}>
          <span aria-hidden="true">👎</span>
          <kbd>←</kbd>
        </button>
        <button type="button" className="act skip" onClick={() => vote("skip")} disabled={!card || loading} aria-label={t("Überspringen (Pfeil runter)", "Skip (down arrow)")} title={t("Überspringen (↓)", "Skip (↓)")}>
          <SkipIcon />
          <kbd>↓</kbd>
        </button>
        <button type="button" className="act like" onClick={() => vote("up")} disabled={!card || loading} aria-label={t("Gefällt mir (Pfeil rechts)", "Like (right arrow)")} title={t("Gefällt mir (→)", "Like (→)")}>
          <span aria-hidden="true">👍</span>
          <kbd>→</kbd>
        </button>
        <button
          type="button"
          className={`act comment${commentFor ? " active" : ""}`}
          onClick={() => (commentFor ? closeComment() : openComment(card ? "current" : "last"))}
          disabled={!card && !lastEntry}
          aria-expanded={!!commentFor}
          aria-label={t("Kommentar (K)", "Comment (K)")}
          title={t("Kommentar (K)", "Comment (K)")}
        >
          <CommentIcon />
          <kbd>K</kbd>
        </button>
      </div>

      <div className="last-vote small" aria-hidden={!lastEntry}>
        {lastEntry && (
          <>
            <span className="muted">
              {t("Zuletzt", "Last")}: {lastEntry.verdict === "up" ? "👍" : lastEntry.verdict === "down" ? "👎" : t("übersprungen", "skipped")} {lastEntry.card.title}
              {lastEntry.comment ? ` · „${lastEntry.comment.length > 40 ? `${lastEntry.comment.slice(0, 40)}…` : lastEntry.comment}“` : ""}
            </span>
            {commentFor !== "last" && (
              <button type="button" className="link-button" onClick={() => openComment("last")}>
                {lastEntry.comment ? t("Kommentar ändern", "Edit comment") : t("Kommentar nachtragen", "Add a comment")}
              </button>
            )}
          </>
        )}
      </div>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>

      <dialog ref={helpDialog} className="dialog help" aria-labelledby="help-title">
        <div className="dialog-head">
          <h2 id="help-title">{t("Tastenkürzel und Gesten", "Shortcuts and gestures")}</h2>
          <form method="dialog">
            <button className="button small ghost" aria-label={t("Schließen", "Close")}>
              ✕
            </button>
          </form>
        </div>
        <dl className="keys">
          <dt><kbd>→</kbd></dt>
          <dd>👍 {t("Gefällt mir – oder nach rechts wischen", "Like – or swipe right")}</dd>
          <dt><kbd>←</kbd></dt>
          <dd>👎 {t("Gefällt mir nicht – oder nach links wischen", "Dislike – or swipe left")}</dd>
          <dt><kbd>↓</kbd></dt>
          <dd>{t("Überspringen – oder nach oben wischen", "Skip – or swipe up")}</dd>
          <dt><kbd>K</kbd></dt>
          <dd>{t("Kommentar schreiben; er wird mit der nächsten Bewertung gespeichert (Esc verlässt das Feld)", "Write a comment; it is saved with the next vote (Esc leaves the field)")}</dd>
          <dt><kbd>Z</kbd></dt>
          <dd>{t("Letzte Bewertung rückgängig", "Undo the last vote")}</dd>
          <dt><kbd>Enter</kbd></dt>
          <dd>{t("Ganzes Bild öffnen (auch Doppelklick)", "Open the full image (or double-click)")}</dd>
          <dt><kbd>?</kbd></dt>
          <dd>{t("Diese Hilfe", "This help")}</dd>
        </dl>
        <p className="muted small">
          {t(
            "Bewertet wird das Bild, nicht die Szene: Ändert sich ein Screenshot in einer neuen Galerie, kommt er wieder in deinen Stapel.",
            "You vote on the image, not the scene: when a screenshot changes in a new gallery, it comes back into your deck.",
          )}
        </p>
      </dialog>

      <dialog ref={imageDialog} className="dialog lightbox" aria-label={card ? card.title : t("Bild", "Image")}>
        {card && (
          <>
            <div className="dialog-head">
              <h2>
                {card.title} <span className="muted small">{variantLabel(t, card.variant)}</span>
              </h2>
              <a className="button small ghost" href={card.image} target="_blank" rel="noopener noreferrer">
                {t("In neuem Tab", "New tab")}
              </a>
              <form method="dialog">
                <button className="button small" autoFocus>
                  {t("Schließen", "Close")}
                </button>
              </form>
            </div>
            <div className="lightbox-image">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={card.image} alt={t(`Screenshot: ${card.title}`, `Screenshot: ${card.title}`)} width={card.width || undefined} height={card.height || undefined} />
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}

// A screenshot with a shimmer until it is loaded (also when it loaded before hydration).
function ShotImage(props: { src: string; alt: string; width: number; height: number; priority: boolean; failedText: string }) {
  const ref = useRef<HTMLImageElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "error">("loading");
  useEffect(() => {
    const img = ref.current;
    if (img?.complete) setState(img.naturalWidth > 0 ? "ok" : "error");
  }, []);
  return (
    <>
      {state !== "ok" && <div className={`shot-placeholder ${state === "error" ? "failed" : ""}`}>{state === "error" ? props.failedText : ""}</div>}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        ref={ref}
        src={props.src}
        alt={props.alt}
        width={props.width || undefined}
        height={props.height || undefined}
        draggable={false}
        decoding="async"
        fetchPriority={props.priority ? "high" : "low"}
        className={state === "ok" ? "ready" : ""}
        onLoad={() => setState("ok")}
        onError={() => setState("error")}
      />
    </>
  );
}

const readVar = (el: HTMLElement, name: string) => parseFloat(el.style.getPropertyValue(name)) || 0;

// The fill of the progress bar: its width is set from script (no style attribute).
function ProgressFill({ percent }: { percent: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    ref.current?.style.setProperty("--p", `${percent}%`);
  }, [percent]);
  return <span className="progress-fill" ref={ref} />;
}

const Svg = ({ children, size = 20 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
const UndoIcon = () => (
  <Svg>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </Svg>
);
const SkipIcon = () => (
  <Svg>
    <path d="m6 15 6-6 6 6" />
    <path d="m6 20 6-6 6 6" opacity=".45" />
  </Svg>
);
const CommentIcon = () => (
  <Svg>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </Svg>
);
const ZoomIcon = () => (
  <Svg size={18}>
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </Svg>
);
const FilterIcon = () => (
  <Svg size={16}>
    <path d="M3 5h18M6 12h12M10 19h4" />
  </Svg>
);
function DeviceIcon({ device }: { device: string }) {
  return device === "phone" ? (
    <Svg size={14}>
      <rect x="7" y="2" width="10" height="20" rx="2" />
      <path d="M11 18h2" />
    </Svg>
  ) : (
    <Svg size={14}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Svg>
  );
}
