import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { pageT, pageUser } from "@/lib/page";
import { config } from "@/lib/config";
import { safeNext } from "@/lib/http";
import { errorMessage } from "@/lib/notices";
import { GitHubIcon } from "@/components/github-button";
import { BrandMark } from "@/components/brand-mark";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await pageT();
  return { title: t("Anmelden", "Sign in") };
}

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [{ t }, user, sp] = await Promise.all([pageT(), pageUser(), searchParams]);
  const next = safeNext(typeof sp.next === "string" ? sp.next : "/", "/");
  if (user?.allowed) redirect(next === "/login" ? "/" : next);
  const error = typeof sp.error === "string" ? sp.error : "";
  const login = typeof sp.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(sp.login) ? sp.login : "";
  const enabled = !!config.oauth();
  const open = config.openVoting();
  const nobody = config.allowedLogins().size === 0;
  const minDays = config.minAccountAgeDays();
  return (
    <div className="signin card">
      <BrandMark size={44} />
      <h1>{t("Galerie bewerten", "Vote on the gallery")}</h1>
      <p className="lede">
        {t(
          "Wisch dich durch die nächtliche UI-Galerie von Flowplan: 👍, 👎 oder überspringen, wenn du magst mit kurzem Kommentar. Die 👎 werden zu Aufgaben fürs nächste Design-Review.",
          "Swipe through Flowplan's nightly UI gallery: 👍, 👎 or skip, with a short comment if you like. The 👎 become tasks for the next design review.",
        )}
      </p>
      {error === "not_allowed" ? (
        <div className="notice err" role="alert">
          <strong>{t("Kein Zugang", "No access")}</strong>
          {open ? (
            <p>
              {login
                ? t(`Das GitHub-Konto „${login}“ kann hier nicht bewerten.`, `The GitHub account “${login}” can't vote here.`)
                : errorMessage("not_allowed", t)}
            </p>
          ) : (
            <p>
              {login
                ? t(`Das GitHub-Konto „${login}“ ist hier nicht freigeschaltet.`, `The GitHub account “${login}” is not enabled here.`)
                : errorMessage("not_allowed", t)}{" "}
              {t("Frag Yannic, wenn du mitbewerten möchtest.", "Ask Yannic if you'd like to vote too.")}
            </p>
          )}
        </div>
      ) : error === "account_too_new" ? (
        <div className="notice err" role="alert">
          <strong>{t("Konto noch zu neu", "Account too new")}</strong>
          <p>
            {t(
              `Damit hier keine Wegwerf-Konten abstimmen, kann ein GitHub-Konto erst ${minDays} Tage nach seiner Erstellung bewerten${login ? ` – „${login}“ ist jünger` : ""}. Schau dann gern wieder vorbei!`,
              `To keep throwaway accounts out, a GitHub account can vote once it is ${minDays} days old${login ? ` – “${login}” is younger` : ""}. Come back then!`,
            )}
          </p>
        </div>
      ) : user && !user.allowed ? (
        <div className="notice err" role="alert">
          <strong>{t("Kein Zugang", "No access")}</strong>
          <p>
            {open
              ? t(`Das GitHub-Konto „${user.login}“ kann hier nicht (mehr) bewerten.`, `The GitHub account “${user.login}” can't (or can no longer) vote here.`)
              : t(`Das GitHub-Konto „${user.login}“ ist hier nicht (mehr) freigeschaltet.`, `The GitHub account “${user.login}” is not (or no longer) enabled here.`)}
          </p>
        </div>
      ) : (
        error && <p className="notice err" role="alert">{errorMessage(error, t)}</p>
      )}
      {sp.signedout === "1" && !error && <p className="notice ok">{t("Du bist abgemeldet.", "You are signed out.")}</p>}
      {nobody && <p className="notice warn">{t("Noch ist niemand zum Bewerten freigeschaltet (VOTE_ALLOWED_LOGINS ist leer).", "Nobody is enabled to vote yet (VOTE_ALLOWED_LOGINS is empty).")}</p>}
      {user && !user.allowed ? (
        <form method="post" action="/api/auth/logout">
          <button className="button" type="submit">
            {t("Abmelden", "Sign out")}
          </button>
        </form>
      ) : enabled ? (
        <a className="button github" href={`/api/auth/login?next=${encodeURIComponent(next)}`}>
          <GitHubIcon />
          {t("Mit GitHub anmelden", "Sign in with GitHub")}
        </a>
      ) : (
        <p className="notice warn">{errorMessage("github_off", t)}</p>
      )}
      <p className="muted small">
        {open
          ? t(
              `Jedes GitHub-Konto kann bewerten${minDays > 0 ? `, das mindestens ${minDays} Tage alt ist` : ""}. Wir speichern nur Login und Namen; ein Cookie hält dich 30 Tage angemeldet. Keine Tracker.`,
              `Every GitHub account can vote${minDays > 0 ? ` that is at least ${minDays} days old` : ""}. We only store your login and name; a cookie keeps you signed in for 30 days. No trackers.`,
            )
          : t(
              "Nur freigeschaltete GitHub-Konten können bewerten. Wir lesen nur Login und Namen; ein Cookie hält dich 30 Tage angemeldet. Keine Tracker.",
              "Only enabled GitHub accounts can vote. We only read your login and name; a cookie keeps you signed in for 30 days. No trackers.",
            )}
      </p>
    </div>
  );
}
