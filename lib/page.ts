// What server components need about the request: the visitor's language
// and, if signed in, the user (with whether they may vote).
import { cookies, headers } from "next/headers";
import { LOCALE_COOKIE, backPath, pickLocale, translate, type Locale } from "./i18n";
import { SESSION_COOKIE, userForSessionToken } from "./auth";

export async function pageLocale(): Promise<Locale> {
  const [c, h] = await Promise.all([cookies(), headers()]);
  return pickLocale(c.get(LOCALE_COOKIE)?.value, h.get("accept-language"));
}
export async function pageT() {
  const locale = await pageLocale();
  return { locale, t: translate(locale) };
}
export async function pageUser() {
  return userForSessionToken((await cookies()).get(SESSION_COOKIE)?.value);
}
// Where a language switch goes back to: the page the visitor is on.
export async function pageBack() {
  const h = await headers();
  return backPath(h.get("x-url") || h.get("referer"));
}
