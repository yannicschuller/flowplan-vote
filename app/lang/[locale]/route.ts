import { LOCALE_COOKIE, isLocale } from "@/lib/i18n";
import { safeNext, setCookie } from "@/lib/http";

// The language switch in the header: remembers the choice (the only cookie
// besides the session, and only when the visitor asks for it) and goes back.
export async function GET(request: Request, ctx: { params: Promise<{ locale: string }> }) {
  const { locale } = await ctx.params;
  const next = safeNext(new URL(request.url).searchParams.get("next"), "/");
  const headers = new Headers({ Location: next, "Cache-Control": "no-store" });
  if (isLocale(locale)) headers.append("Set-Cookie", setCookie(LOCALE_COOKIE, locale, { maxAge: 365 * 86_400 }));
  return new Response(null, { status: 303, headers });
}
