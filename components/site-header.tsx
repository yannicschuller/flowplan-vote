import Link from "next/link";
import { BrandMark } from "./brand-mark";
import { pageBack, pageT, pageUser } from "@/lib/page";
import { switchLanguageHref, type Locale } from "@/lib/i18n";

const LANGUAGES: { locale: Locale; short: string; name: string }[] = [
  { locale: "de", short: "DE", name: "Deutsch" },
  { locale: "en", short: "EN", name: "English" },
];

export async function SiteHeader() {
  const [{ t, locale }, user, back] = await Promise.all([pageT(), pageUser(), pageBack()]);
  return (
    <header className="site-header">
      <div className="bar">
        <Link href="/" className="brand" aria-label={t("Flowplan Vote – bewerten", "Flowplan Vote – vote")}>
          <BrandMark />
          <span className="brand-name">Flowplan</span>
          <small>Vote</small>
        </Link>
        <nav className="nav" aria-label={t("Hauptnavigation", "Main navigation")}>
          {user?.allowed && (
            <>
              <Link href="/">{t("Bewerten", "Vote")}</Link>
              <Link href="/mine">
                <span className="long">{t("Meine Bewertungen", "My votes")}</span>
                <span className="short">{t("Meine", "Mine")}</span>
              </Link>
            </>
          )}
          {user ? (
            <form className="inline" method="post" action="/api/auth/logout">
              <button type="submit" title={`${t("Abmelden", "Sign out")} (${user.login})`}>
                {t("Abmelden", "Sign out")}
              </button>
            </form>
          ) : (
            <Link href={`/login?next=${encodeURIComponent(back)}`}>{t("Anmelden", "Sign in")}</Link>
          )}
        </nav>
        <nav className="header-lang" aria-label={t("Sprache", "Language")}>
          {LANGUAGES.map((l) => (
            <a key={l.locale} href={switchLanguageHref(l.locale, back)} hrefLang={l.locale} lang={l.locale} aria-label={l.name} title={l.name} aria-current={l.locale === locale ? "true" : undefined}>
              {l.short}
            </a>
          ))}
        </nav>
      </div>
    </header>
  );
}
