"use client";
// The one help dialog of the voting screen: what the gallery is, the legend
// of the buttons (swipe and key for each) and the rules. It opens by itself
// on the first visit in this browser (localStorage; without it, once per
// session or page load) and any time from the header button or `?`.
// Closing it in any way counts as seen.
import { useEffect, useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { useT } from "./i18n";
import { BackIcon, CommentIcon, ForwardIcon, SkipIcon, ZoomIcon } from "./vote-icons";

const SEEN_KEY = "fv_guide_seen";
let seenThisPage = false;

function seen(): boolean {
  if (seenThisPage) return true;
  for (const storage of ["localStorage", "sessionStorage"] as const) {
    try {
      return window[storage].getItem(SEEN_KEY) === "1";
    } catch {
      // Storage blocked: try the next one, then fall back to this page load.
    }
  }
  return false;
}
function markSeen() {
  seenThisPage = true;
  for (const storage of ["localStorage", "sessionStorage"] as const) {
    try {
      window[storage].setItem(SEEN_KEY, "1");
      return;
    } catch {
      // Storage blocked: try the next one.
    }
  }
}

export function VoterHelp({ dialogRef }: { dialogRef: RefObject<HTMLDialogElement | null> }) {
  const t = useT();
  const [first, setFirst] = useState(false);
  const start = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const onClose = () => {
      markSeen();
      setFirst(false);
    };
    // "close" comes a task later; Esc ("cancel") and the buttons mark it at once.
    dialog.addEventListener("close", onClose);
    dialog.addEventListener("cancel", markSeen);
    if (!seen() && !dialog.open && !document.querySelector("dialog[open]")) {
      setFirst(true);
      dialog.showModal();
      start.current?.focus();
    }
    return () => {
      dialog.removeEventListener("close", onClose);
      dialog.removeEventListener("cancel", markSeen);
    };
  }, [dialogRef]);

  return (
    <dialog ref={dialogRef} className="dialog help" aria-labelledby="help-title" aria-describedby="help-intro">
      <div className="dialog-head">
        <h2 id="help-title">{t("So funktioniert's", "How it works")}</h2>
        <form method="dialog">
          <button className="button small ghost" aria-label={t("Schließen", "Close")} onClick={markSeen}>
            ✕
          </button>
        </form>
      </div>

      <div className="help-body">
        <div className="help-intro">
          <SwipeDemo />
          <p id="help-intro">
            {t(
              "Jede Nacht macht Flowplan Screenshots von allen Bildschirmen der App – Desktop und Phone, hell und dunkel. Hier gehst du sie einzeln durch und sagst, was dir gefällt und was nicht. Aus den 👎 und deinen Kommentaren werden Verbesserungen.",
              "Every night Flowplan takes screenshots of every screen of the app – desktop and phone, light and dark. Here you go through them one by one and say what you like and what you don't. The 👎 and your comments turn into improvements.",
            )}
          </p>
        </div>

        <h3 className="help-heading">{t("Die Knöpfe", "The buttons")}</h3>
        <ul className="legend">
          <LegendRow kind="like" icon={<span aria-hidden="true">👍</span>} name={t("Gefällt mir", "Like")} swipe={t("nach rechts wischen", "swipe right")} keyCap="↑ K">
            {t("Der Bildschirm passt so.", "This screen is fine as it is.")}
          </LegendRow>
          <LegendRow kind="nope" icon={<span aria-hidden="true">👎</span>} name={t("Gefällt nicht", "Don't like")} swipe={t("nach links wischen", "swipe left")} keyCap="↓ J">
            {t("Etwas stört dich – am besten mit kurzem Kommentar, was.", "Something bothers you – best with a short comment on what.")}
          </LegendRow>
          <LegendRow kind="skip" icon={<SkipIcon />} name={t("Überspringen", "Skip")} swipe={t("nach oben wischen", "swipe up")} keyCap="→ L">
            {t("Keine Meinung: zählt weder als 👍 noch als 👎, das Bild ist trotzdem erledigt.", "No opinion: counts as neither 👍 nor 👎, but the image is done.")}
          </LegendRow>
          <LegendRow kind="comment" icon={<CommentIcon />} name={t("Kommentar", "Comment")} keyCap="C">
            {t(
              "Schreib kurz, was dir auffällt – er gehört zu dieser Karte und wird mit deiner Bewertung gespeichert, auch wenn du das Feld schließt (ein Punkt am Knopf zeigt den Entwurf). Schon bewertet? Unter den Knöpfen steht „Kommentar nachtragen“.",
              "Write briefly what you notice – it belongs to this card and is saved with your vote, even if you close the field (a dot on the button shows the draft). Already voted? Use “Add a comment” under the buttons.",
            )}
          </LegendRow>
          <LegendRow kind="back" icon={<BackIcon />} name={t("Zurück", "Back")} keyCap="← Z">
            {t(
              "Zeigt die vorige Karte wieder, mit deiner Bewertung und deinem Kommentar – mehrmals drücken geht weiter zurück. Deine Bewertung bleibt gespeichert, bis du die Karte neu bewertest.",
              "Shows the previous card again, with your vote and comment – press again to go further back. Your vote stays saved until you vote on the card again.",
            )}
          </LegendRow>
          <LegendRow kind="forward" icon={<ForwardIcon />} name={t("Vor", "Forward")} keyCap="⇧→ X">
            {t(
              "Nur nach „Zurück“: geht wieder vor, deine Bewertung bleibt, wie sie ist. Hast du den Kommentar geändert, wird er mit derselben Bewertung gespeichert.",
              "Only after “Back”: moves forward again and leaves your vote as it is. If you changed the comment, it is saved with the same vote.",
            )}
          </LegendRow>
        </ul>
        <p className="help-more muted small">
          <span className="help-keys">
            <kbd>Enter</kbd> {t("oder Doppelklick: ganzes Bild", "or double-click: full image")} · <kbd>?</kbd> {t("diese Hilfe", "this help")} · <kbd>Esc</kbd>{" "}
            {t("schließt", "closes")}
          </span>
          <span className="help-touch">
            <ZoomIcon /> {t("unten rechts im Bild öffnet es in voller Größe.", "at the bottom right of the image opens it full size.")}
          </span>
        </p>

        <h3 className="help-heading">{t("Gut zu wissen", "Good to know")}</h3>
        <ul className="help-rules">
          <li>
            {t(
              "Bewertet wird das Bild, nicht die Szene: Ändert sich ein Bildschirm in einer neuen Galerie, kommt er wieder in deinen Stapel – markiert mit „Geändert“.",
              "You vote on the image, not the scene: when a screen changes in a new gallery, it comes back into your deck – marked “Changed”.",
            )}
          </li>
          <li>
            {t(
              "Deine Bewertungen und Kommentare sieht der Maintainer zusammen mit deinem GitHub-Namen.",
              "The maintainer sees your votes and comments together with your GitHub name.",
            )}
          </li>
          <li>
            {t(
              "Der Maintainer kann eine Bewertung zurücksetzen: Sie zählt dann nicht mehr, und das Bild kommt wieder in deinen Stapel – markiert mit „Deine frühere Stimme wurde zurückgesetzt“.",
              "The maintainer can reset a vote: it no longer counts and the image comes back into your deck – marked “Your earlier vote was reset”.",
            )}
          </li>
          <li>
            {t("Unter ", "Under ")}
            <Link href="/mine">{t("Meine Bewertungen", "My votes")}</Link>
            {t(
              " findest du alles, was du bewertet hast, und kannst es ändern oder löschen.",
              " you find everything you voted on and can change or delete it.",
            )}
          </li>
        </ul>
      </div>

      <form method="dialog" className="help-foot">
        <button ref={start} className="button primary" onClick={markSeen}>
          {first ? t("Los geht's", "Let's go") : t("Weiter bewerten", "Back to voting")}
        </button>
      </form>
    </dialog>
  );
}

function LegendRow(props: { kind: string; icon: React.ReactNode; name: string; swipe?: string; keyCap: string; children: React.ReactNode }) {
  return (
    <li className="legend-row">
      <span className={`legend-icon ${props.kind}`} aria-hidden="true">
        {props.icon}
      </span>
      <span className="legend-text">
        <strong>{props.name}</strong>
        <span className="muted">{props.children}</span>
      </span>
      <span className="legend-how">
        {props.swipe && <span className="legend-swipe">{props.swipe}</span>}
        <kbd>{props.keyCap}</kbd>
      </span>
    </li>
  );
}

// A small card that swipes right, left and up in a loop (still with reduced motion).
function SwipeDemo() {
  const t = useT();
  return (
    <div className="swipe-demo" role="img" aria-label={t("Karte nach rechts, links oder oben wischen", "Swipe the card right, left or up")}>
      <span className="swipe-arrow left">←</span>
      <span className="swipe-arrow up">↑</span>
      <span className="swipe-arrow right">→</span>
      <span className="swipe-card">
        <span className="swipe-line" />
        <span className="swipe-line short" />
        <span className="swipe-stamp like">👍</span>
        <span className="swipe-stamp nope">👎</span>
      </span>
    </div>
  );
}
