"use client";
// The voting screen: a stack of gallery screenshots, one at a time.
// Swipe right 👍, left 👎, up to skip (pointer events: touch and mouse), or
// use the buttons and keys (↑/K like, ↓/J dislike, →/L skip, C comment, ←/Z back,
// Shift+→/X forward, Enter full image, ? help – voter-help.tsx, which also opens by itself on the first visit). Votes go out at once through the queue (vote-queue.ts), which
// keeps them while offline. Every position is set through CSS custom
// properties from script – never a style attribute (CSP).
//
// A comment draft belongs to its card (#439): it is keyed by the image, goes
// out with that card's verdict even when the panel is closed, and is gone
// after the vote – the next card starts with its own saved comment or none.
// Back (←/Z) only walks back through this round's history (up to 50 cards):
// the card comes back with your verdict shown and your comment as its draft;
// the vote stays saved until you vote on the card again, which replaces it.
// Forward (Shift+→/X, only while there are cards you went back over) walks
// those again without a request – unless you changed the comment: then it is
// saved with the same verdict. Voting on such a card replaces the vote and
// moves forward too; at the first card you never voted on, Forward is gone.
// Each card keeps its own draft meanwhile (also the one you went back from).
// The "last vote" comment (commentFor "last") has its own text and never
// touches the draft.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "./i18n";
import { BackIcon, CommentIcon, DeviceIcon, FilterIcon, ForwardIcon, SkipIcon, ZoomIcon } from "./vote-icons";
import { VoterHelp } from "./voter-help";
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
type HistoryEntry = { index: number; card: Card; verdict: Verdict; comment: string };
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
  // The cards you went back over, the one on top last (its index is the current one).
  const [ahead, setAhead] = useState<HistoryEntry[]>([]);
  // What this person has on each image (from the server, then as changed here).
  const mine = useRef(new Map<string, Mine>());
  // Comment drafts, keyed by image; a card without one shows its saved comment
  // (see draftOf). An empty entry is a draft used up by the vote.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const setDraft = (key: string, text: string | null) =>
    setDrafts((d) => {
      const next = { ...d };
      if (text === null) delete next[key];
      else next[key] = text;
      return next;
    });
  // The text while editing the comment of the last vote.
  const [lastText, setLastText] = useState("");
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
      setAhead([]);
      setDrafts({});
      setCommentFor((f) => (f === "last" ? null : f));
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

  // What this person has on a card now, and the comment draft for it.
  const savedOf = (c: Card): Mine => {
    const key = imageKey(c);
    return mine.current.has(key) ? mine.current.get(key)! : c.vote;
  };
  const draftOf = (c: Card) => drafts[imageKey(c)] ?? savedOf(c)?.comment ?? "";
  // For the announcements: your vote on a card you have seen before.
  const savedNote = (c: Card) => {
    const saved = savedOf(c);
    if (!saved) return "";
    return t(
      ` Deine Bewertung: ${verdictLabel(t, saved.verdict)}${saved.comment ? " (mit Kommentar)" : ""} – bleibt gespeichert, bis du neu bewertest.`,
      ` Your vote: ${verdictLabel(t, saved.verdict)}${saved.comment ? " (with comment)" : ""} – it stays saved until you vote again.`,
    );
  };
  const nextNote = (next: Card, revisited: boolean) =>
    `${t("Nächstes", "Next")}: ${next.title}, ${variantLabel(t, next.variant)}.${revisited ? savedNote(next) : ""}`;

  const vote = (verdict: Verdict) => {
    finishFlight();
    const i = indexRef.current;
    const c = cards[i];
    if (!c || loading) return;
    const key = imageKey(c);
    // The draft goes with the verdict, open panel or not (#439).
    const text = draftOf(c).trim();
    mine.current.set(key, { verdict, comment: text });
    queue.current?.push({ scene: c.scene, variant: c.variant, hash: c.hash, action: "set", verdict, comment: text });
    setHistory((h) => [...h.slice(-49), { index: i, card: c, verdict, comment: text }]);
    // A card you went back over: voted again, it is no longer ahead.
    setAhead((a) => (a[a.length - 1]?.index === i ? a.slice(0, -1) : a));
    const next = cards[i + 1];
    // The draft is used up (also while the card flies out); the next card starts
    // with its own draft or saved comment, never the old text.
    setDraft(key, "");
    setCommentFor(next && draftOf(next) ? "current" : null);
    setLastText("");
    setNotice(null);
    setAnnouncement(
      `${verdictLabel(t, verdict)}: ${c.title}${text ? ` (${t("mit Kommentar", "with comment")})` : ""}. ` +
        (next ? nextNote(next, ahead.length > 1 && ahead[ahead.length - 1]?.index === i) : t("Alles bewertet.", "All done.")),
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

  // Back: the previous card on top again, with your verdict and comment – the
  // vote stays saved (nothing is sent) until you vote on the card again.
  const back = () => {
    finishFlight();
    const last = history[history.length - 1];
    if (!last || loading) return;
    // The card that just flew out may be the one coming back: at rest again
    // (the index ends where it was, so the effect below would not reset it).
    const el = topCard.current;
    el?.classList.remove("dragging", "settling", "flying", "fly-right", "fly-left", "fly-up");
    setVars(el, 0, 0);
    setHistory((h) => h.slice(0, -1));
    setAhead((a) => [...a, last]);
    setIndex(last.index);
    // The card comes back with its saved comment; other cards keep their drafts.
    setDraft(imageKey(last.card), null);
    setLastText("");
    const saved = savedOf(last.card);
    setCommentFor(saved?.comment ? "current" : null);
    setNotice(null);
    setAnnouncement(`${t("Zurück", "Back")}: ${last.card.title}.${savedNote(last.card)}`);
  };

  // Forward: the next card you went back over, its vote unchanged (nothing is
  // sent) – unless you edited its comment: that is saved with the same verdict.
  const forward = () => {
    finishFlight();
    const i = indexRef.current;
    const entry = ahead[ahead.length - 1];
    const c = cards[i];
    if (!entry || !c || entry.index !== i || loading) return;
    const key = imageKey(c);
    const saved = savedOf(c);
    const verdict = saved?.verdict ?? entry.verdict;
    const text = draftOf(c).trim();
    const changed = text !== (saved?.comment ?? "");
    if (changed) {
      mine.current.set(key, { verdict, comment: text });
      queue.current?.push({ scene: c.scene, variant: c.variant, hash: c.hash, action: "set", verdict, comment: text });
    }
    setHistory((h) => [...h.slice(-49), { index: i, card: c, verdict, comment: text }]);
    setAhead((a) => a.slice(0, -1));
    setIndex(i + 1);
    const next = cards[i + 1];
    setDraft(key, null);
    setCommentFor(next && draftOf(next) ? "current" : null);
    setLastText("");
    setNotice(null);
    setAnnouncement(
      (changed ? `${t("Kommentar gespeichert", "Comment saved")}: ${c.title}. ` : "") +
        (next ? `${t("Vor", "Forward")}: ${next.title}.${savedNote(next)}` : t("Alles bewertet.", "All done.")),
    );
  };

  // A comment for the card on top (sent with the verdict) or for the last vote (sent at once).
  const openComment = (target: "current" | "last") => {
    if (target === "current" && !cards[indexRef.current]) return;
    if (target === "last") {
      const last = history[history.length - 1];
      if (!last) return;
      setLastText(last.comment);
    }
    setCommentFor(target);
    requestAnimationFrame(() => commentField.current?.focus());
  };
  const saveLastComment = () => {
    const last = history[history.length - 1];
    if (!last) return;
    const text = lastText.trim();
    mine.current.set(imageKey(last.card), { verdict: last.verdict, comment: text });
    queue.current?.push({ scene: last.card.scene, variant: last.card.variant, hash: last.card.hash, action: "set", verdict: last.verdict, comment: text });
    setHistory((h) => [...h.slice(0, -1), { ...last, comment: text }]);
    setLastText("");
    setCommentFor(null);
    setAnnouncement(t("Kommentar gespeichert.", "Comment saved."));
  };
  // Closing keeps the draft of the card on top: it still goes with the verdict.
  const closeComment = () => {
    if (commentFor === "last") setLastText("");
    setCommentFor(null);
    stack.current?.focus();
  };
  const editComment = (text: string) => {
    if (commentFor === "last") return setLastText(text);
    const c = cards[indexRef.current];
    if (c) setDraft(imageKey(c), text);
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
        if (!panelText.trim()) closeComment();
        else stack.current?.focus();
      }
      return;
    }
    const onControl = e.target instanceof HTMLElement && /^(BUTTON|A|SUMMARY)$/.test(e.target.tagName);
    switch (e.key) {
      // Thumbs up goes up, thumbs down goes down, → moves on (#437).
      case "ArrowUp":
      case "k":
      case "K":
        e.preventDefault();
        return vote("up");
      case "ArrowDown":
      case "j":
      case "J":
        e.preventDefault();
        return vote("down");
      case "ArrowRight":
      case "l":
      case "L":
        e.preventDefault();
        return e.key === "ArrowRight" && e.shiftKey ? forward() : vote("skip");
      case "x":
      case "X":
        e.preventDefault();
        return forward();
      case "c":
      case "C":
        e.preventDefault();
        return openComment("current");
      case "ArrowLeft":
      case "z":
      case "Z":
        e.preventDefault();
        return back();
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
  // Cards you went back over (the one on top is the first of them; also while
  // a revisited card flies out, so the row does not jump).
  const canForward = ahead.length > 0;
  const percent = total ? Math.round((done / total) * 100) : 100;
  const current = card ? savedOf(card) : null;
  const panelText = commentFor === "last" ? lastText : card ? draftOf(card) : "";
  // A draft waiting behind the closed panel: the comment button shows it.
  const hasDraft = !commentFor && !!card && !!draftOf(card).trim();

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
        <button type="button" className="button small ghost help-button" onClick={() => helpDialog.current?.showModal()} aria-label={t("Hilfe (?)", "Help (?)")} title={t("So funktioniert's (?)", "How it works (?)")} aria-haspopup="dialog">
          <span className="help-mark" aria-hidden="true">
            ?
          </span>
          <span className="help-word">{t("Hilfe", "Help")}</span>
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
                      {depth === 0 && !current && c.reset && (
                        <span className="chip reset" title={t("Der Maintainer hat deine Stimme zu diesem Bild zurückgesetzt – bewerte es gern noch einmal.", "The maintainer reset your vote on this image – feel free to vote again.")}>
                          {t("Deine frühere Stimme wurde zurückgesetzt", "Your earlier vote was reset")}
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
            value={panelText}
            onChange={(e) => editComment(e.target.value)}
            placeholder={t("Was fällt dir auf? (optional, kurz)", "What do you notice? (optional, short)")}
          />
          <div className="comment-actions">
            <span className="muted small">{panelText.length} / 500</span>
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
        <ActButton kind="back" onClick={back} disabled={!history.length || loading} name={t("Zurück zur vorigen Karte (Pfeil links oder Z)", "Back to the previous card (left arrow or Z)")} title={t("Zurück (← oder Z)", "Back (← or Z)")} label={t("Zurück", "Back")} keyCap="←">
          <BackIcon />
        </ActButton>
        {canForward && (
          <ActButton kind="forward" onClick={forward} disabled={loading} name={t("Vor zur nächsten Karte, Bewertung bleibt (Umschalt+Pfeil rechts oder X)", "Forward to the next card, vote unchanged (Shift+right arrow or X)")} title={t("Vor (⇧→ oder X) – deine Bewertung bleibt", "Forward (⇧→ or X) – your vote stays")} label={t("Vor", "Forward")} keyCap="⇧→">
            <ForwardIcon />
          </ActButton>
        )}
        <ActButton kind="nope" onClick={() => vote("down")} disabled={!card || loading} name={t("Gefällt nicht (Pfeil runter oder J)", "Don't like (down arrow or J)")} title={t("Gefällt nicht (↓ oder J)", "Don't like (↓ or J)")} label={t("Gefällt nicht", "Don't like")} keyCap="↓">
          <span aria-hidden="true">👎</span>
        </ActButton>
        <ActButton kind="skip" onClick={() => vote("skip")} disabled={!card || loading} name={t("Überspringen (Pfeil rechts oder L)", "Skip (right arrow or L)")} title={t("Überspringen (→ oder L)", "Skip (→ or L)")} label={t("Überspringen", "Skip")} keyCap="→">
          <SkipIcon />
        </ActButton>
        <ActButton kind="like" onClick={() => vote("up")} disabled={!card || loading} name={t("Gefällt mir (Pfeil hoch oder K)", "Like (up arrow or K)")} title={t("Gefällt mir (↑ oder K)", "Like (↑ or K)")} label={t("Gefällt mir", "Like")} keyCap="↑">
          <span aria-hidden="true">👍</span>
        </ActButton>
        <ActButton
          kind={`comment${commentFor ? " active" : ""}${hasDraft ? " draft" : ""}`}
          onClick={() => (commentFor ? closeComment() : openComment(card ? "current" : "last"))}
          disabled={!card && !lastEntry}
          expanded={!!commentFor}
          name={hasDraft ? t("Kommentar (Entwurf) (C)", "Comment (draft) (C)") : t("Kommentar (C)", "Comment (C)")}
          title={hasDraft ? t("Kommentar (C) – Entwurf, wird mit deiner Bewertung gespeichert", "Comment (C) – draft, saved with your vote") : t("Kommentar (C)", "Comment (C)")}
          label={t("Kommentar", "Comment")}
          keyCap="C"
        >
          <CommentIcon />
          {hasDraft && <span className="draft-dot" />}
        </ActButton>
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

      <VoterHelp dialogRef={helpDialog} />

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

// One action: the round button with its label and key cap under it – all one
// button, so the label is part of the target. The accessible name keeps the key.
function ActButton(props: { kind: string; onClick: () => void; disabled: boolean; expanded?: boolean; name: string; title: string; label: string; keyCap: string; children: React.ReactNode }) {
  return (
    <button type="button" className={`act-button ${props.kind}`} onClick={props.onClick} disabled={props.disabled} aria-expanded={props.expanded} aria-label={props.name} title={props.title}>
      <span className="act" aria-hidden="true">
        {props.children}
      </span>
      <span className="act-label" aria-hidden="true">
        <span className="act-text">{props.label}</span>
        <kbd>{props.keyCap}</kbd>
      </span>
    </button>
  );
}
