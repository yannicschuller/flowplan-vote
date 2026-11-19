// Two languages: German and English. Texts sit next to each other in the
// code as t("Deutsch", "English"), like in Flowplan. Client-safe.
export type Locale = "de" | "en";
// Set only when the visitor switches the language (app/lang/[locale]).
export const LOCALE_COOKIE = "fv_lang";
export const isLocale = (v: unknown): v is Locale => v === "de" || v === "en";

// The visitor's choice (header switch) wins, else the browser's languages in order.
export function pickLocale(cookie: string | undefined | null, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookie)) return cookie;
  const ranked = (acceptLanguage || "")
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^q=([\d.]+)$/.exec(p.trim())?.[1]).find(Boolean);
      return { lang: tag.toLowerCase().split("-")[0], q: q ? Number(q) : 1 };
    })
    .filter((x) => x.lang && x.q > 0)
    .sort((a, b) => b.q - a.q);
  for (const { lang } of ranked) if (isLocale(lang)) return lang;
  return "en";
}
// The language switches (header and footer): /lang/<locale> remembers the
// choice in the language cookie and goes back to `back` (path and query of
// the page the visitor is on, from the proxy's x-url header or the referer).
export function backPath(url: string | null | undefined) {
  try {
    const u = new URL(url || "/", "http://x");
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}
export const switchLanguageHref = (locale: Locale, back: string) => `/lang/${locale}?next=${encodeURIComponent(back)}`;

export type T = (de: string, en: string) => string;
export const translate = (locale: Locale): T => (de, en) => (locale === "de" ? de : en);

// Dates and times in the configured time zone (VOTE_TIME_ZONE, see
// lib/config.ts; the server passes it – a container runs in UTC otherwise).
export const DEFAULT_TIME_ZONE = "Europe/Berlin";
export function formatDate(locale: Locale, at: number, timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone }).format(at);
}
export function formatDateTime(locale: Locale, at: number, timeZone = DEFAULT_TIME_ZONE) {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone }).format(at);
}
export const formatNumber = (locale: Locale, n: number) => new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-GB").format(n);
