"use client";
// "My votes": filter the list, change the verdict, edit the comment or
// delete a vote (two steps). Changes are sent at once.
import { useMemo, useState } from "react";
import Link from "next/link";
import { useLocale, useT } from "./i18n";
import { formatDateTime } from "@/lib/i18n";
import { variantLabel, verdictLabel } from "@/lib/labels";
import { errorMessage } from "@/lib/notices";
import type { MyVote, Verdict } from "@/lib/votes";

type Props = { votes: MyVote[]; groups: string[]; variants: string[]; timeZone: string };
const PAGE = 60;

export function MyVotes(props: Props) {
  const t = useT();
  const [votes, setVotes] = useState(props.votes);
  const [verdict, setVerdict] = useState<"" | Verdict | "comment">("");
  const [group, setGroup] = useState("");
  const [variant, setVariant] = useState("");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return votes.filter(
      (v) =>
        (!verdict || (verdict === "comment" ? !!v.comment : v.verdict === verdict)) &&
        (!group || v.group === group) &&
        (!variant || v.variant === variant) &&
        (!needle || `${v.title} ${v.scene} ${v.comment}`.toLowerCase().includes(needle)),
    );
  }, [votes, verdict, group, variant, q]);
  const counts = useMemo(() => {
    const c = { up: 0, down: 0, skip: 0, comment: 0 };
    for (const v of votes) {
      c[v.verdict]++;
      if (v.comment) c.comment++;
    }
    return c;
  }, [votes]);

  async function send(id: number, method: "PATCH" | "DELETE", body?: Record<string, unknown>) {
    setMessage(null);
    try {
      const response = await fetch(`/api/votes/${id}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await response.json().catch(() => ({}))) as { error?: string; vote?: MyVote };
      if (!response.ok) throw new Error(data.error || "failed");
      if (method === "DELETE") {
        setVotes((list) => list.filter((v) => v.id !== id));
        setMessage({ kind: "ok", text: t("Bewertung gelöscht – das Bild ist wieder in deinem Stapel.", "Vote deleted – the image is back in your deck.") });
      } else if (data.vote) {
        setVotes((list) => list.map((v) => (v.id === id ? { ...v, ...data.vote } : v)));
        setMessage({ kind: "ok", text: t("Gespeichert.", "Saved.") });
      }
      return true;
    } catch (error) {
      setMessage({ kind: "err", text: navigator.onLine ? errorMessage((error as Error).message, t) : t("Keine Verbindung – versuch es gleich noch einmal.", "No connection – please try again in a moment.") });
      return false;
    }
  }

  if (!props.votes.length)
    return (
      <div className="card empty">
        <p>{t("Du hast noch nichts bewertet.", "You haven't voted on anything yet.")}</p>
        <Link className="button primary" href="/">
          {t("Jetzt bewerten", "Start voting")}
        </Link>
      </div>
    );

  const tabs: { value: "" | Verdict | "comment"; label: string; count: number }[] = [
    { value: "", label: t("Alle", "All"), count: votes.length },
    { value: "down", label: "👎", count: counts.down },
    { value: "up", label: "👍", count: counts.up },
    { value: "skip", label: t("Übersprungen", "Skipped"), count: counts.skip },
    { value: "comment", label: t("Mit Kommentar", "With comment"), count: counts.comment },
  ];

  return (
    <div className="mine">
      <div className="mine-filters">
        <div className="tabs" role="group" aria-label={t("Urteil", "Verdict")}>
          {tabs.map((tab) => (
            <button
              key={tab.value || "all"}
              type="button"
              className="tab"
              aria-pressed={verdict === tab.value}
              aria-label={tab.value === "up" || tab.value === "down" ? `${verdictLabel(t, tab.value)} (${tab.count})` : undefined}
              onClick={() => {
                setVerdict(tab.value);
                setShown(PAGE);
              }}
            >
              {tab.label} <span className="count">{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="row filter-row">
          <label className="field">
            <span className="visually-hidden">{t("Gruppe", "Group")}</span>
            <select value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">{t("Alle Gruppen", "All groups")}</option>
              {props.groups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="visually-hidden">{t("Variante", "Variant")}</span>
            <select value={variant} onChange={(e) => setVariant(e.target.value)}>
              <option value="">{t("Alle Varianten", "All variants")}</option>
              {props.variants.map((v) => (
                <option key={v} value={v}>
                  {variantLabel(t, v)}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span className="visually-hidden">{t("Suchen", "Search")}</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("Titel, Szene oder Kommentar suchen", "Search title, scene or comment")} />
          </label>
        </div>
      </div>
      {message && (
        <p className={`notice ${message.kind}`} role={message.kind === "err" ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      <p className="muted small" role="status">
        {t(`${filtered.length} von ${votes.length}`, `${filtered.length} of ${votes.length}`)}
      </p>
      {filtered.length === 0 ? (
        <p className="card empty muted">{t("Nichts in diesem Filter.", "Nothing in this filter.")}</p>
      ) : (
        <ul className="vote-list">
          {filtered.slice(0, shown).map((v) => (
            <VoteItem key={v.id} vote={v} timeZone={props.timeZone} send={send} />
          ))}
        </ul>
      )}
      {filtered.length > shown && (
        <button type="button" className="button more" onClick={() => setShown((s) => s + PAGE)}>
          {t(`Weitere ${Math.min(PAGE, filtered.length - shown)} zeigen`, `Show ${Math.min(PAGE, filtered.length - shown)} more`)}
        </button>
      )}
    </div>
  );
}

function VoteItem({ vote, timeZone, send }: { vote: MyVote; timeZone: string; send: (id: number, method: "PATCH" | "DELETE", body?: Record<string, unknown>) => Promise<boolean> }) {
  const t = useT();
  const locale = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(vote.comment);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<boolean>) => {
    setBusy(true);
    const ok = await fn();
    setBusy(false);
    return ok;
  };
  const verdicts: { value: Verdict; label: string }[] = [
    { value: "up", label: "👍" },
    { value: "down", label: "👎" },
    { value: "skip", label: t("Skip", "Skip") },
  ];
  return (
    <li className={`vote-item ${vote.verdict}`}>
      {vote.thumb ? (
        <a className="thumb" href={vote.image} target="_blank" rel="noopener noreferrer" aria-label={t(`Bild öffnen: ${vote.title}`, `Open image: ${vote.title}`)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={vote.thumb} alt="" loading="lazy" decoding="async" />
        </a>
      ) : (
        <span className="thumb missing" aria-hidden="true" />
      )}
      <div className="vote-body">
        <div className="vote-head">
          <h2>{vote.title}</h2>
          <span className="muted small">
            {vote.group} · {variantLabel(t, vote.variant)} · {formatDateTime(locale, vote.createdAt, timeZone)}
          </span>
          {!vote.current && <span className="chip changed">{vote.thumb ? t("Bild hat sich seitdem geändert", "Image changed since") : t("Nicht mehr in der Galerie", "No longer in the gallery")}</span>}
        </div>
        {editing ? (
          <div className="comment-edit">
            <label className="visually-hidden" htmlFor={`c-${vote.id}`}>
              {t("Kommentar", "Comment")}
            </label>
            <textarea id={`c-${vote.id}`} rows={2} maxLength={500} value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus />
            <div className="row">
              <button type="button" className="button small primary" disabled={busy} onClick={() => run(() => send(vote.id, "PATCH", { comment: draft })).then((ok) => ok && setEditing(false))}>
                {t("Speichern", "Save")}
              </button>
              <button
                type="button"
                className="button small ghost"
                onClick={() => {
                  setDraft(vote.comment);
                  setEditing(false);
                }}
              >
                {t("Abbrechen", "Cancel")}
              </button>
              <span className="muted small">{draft.length} / 500</span>
            </div>
          </div>
        ) : vote.comment ? (
          <blockquote className="vote-comment">{vote.comment}</blockquote>
        ) : null}
        <div className="vote-actions">
          <div className="segmented" role="group" aria-label={t("Urteil ändern", "Change verdict")}>
            {verdicts.map((x) => (
              <button
                key={x.value}
                type="button"
                className={x.value}
                aria-pressed={vote.verdict === x.value}
                aria-label={verdictLabel(t, x.value)}
                disabled={busy}
                onClick={() => vote.verdict !== x.value && run(() => send(vote.id, "PATCH", { verdict: x.value }))}
              >
                {x.label}
              </button>
            ))}
          </div>
          {!editing && (
            <button type="button" className="button small ghost" onClick={() => setEditing(true)}>
              {vote.comment ? t("Kommentar bearbeiten", "Edit comment") : t("Kommentar hinzufügen", "Add comment")}
            </button>
          )}
          <span className="spacer" />
          {confirmDelete ? (
            <>
              <button type="button" className="button small danger" disabled={busy} onClick={() => run(() => send(vote.id, "DELETE"))}>
                {t("Wirklich löschen", "Really delete")}
              </button>
              <button type="button" className="button small ghost" onClick={() => setConfirmDelete(false)}>
                {t("Abbrechen", "Cancel")}
              </button>
            </>
          ) : (
            <button type="button" className="button small ghost danger" onClick={() => setConfirmDelete(true)}>
              {t("Löschen", "Delete")}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
