import { redirect } from "next/navigation";
import Link from "next/link";
import { pageT, pageUser } from "@/lib/page";
import { galleryOrNull } from "@/lib/gallery";
import { deck, progress } from "@/lib/votes";
import { config } from "@/lib/config";
import { formatDate } from "@/lib/i18n";
import { Voter } from "@/components/voter";

export const dynamic = "force-dynamic";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function Home({ searchParams }: Props) {
  const [{ t, locale }, user, sp] = await Promise.all([pageT(), pageUser(), searchParams]);
  if (!user) redirect("/login");
  if (!user.allowed) redirect("/login?error=not_allowed");
  const g = await galleryOrNull();
  if (!g)
    return (
      <div className="signin card">
        <h1>{t("Galerie nicht erreichbar", "Gallery not reachable")}</h1>
        <p className="lede">
          {t(
            `Die UI-Galerie (${config.galleryUrl()}) antwortet gerade nicht. Versuch es gleich noch einmal.`,
            `The UI gallery (${config.galleryUrl()}) is not answering right now. Please try again in a moment.`,
          )}
        </p>
        <Link className="button primary" href="/">
          {t("Neu laden", "Reload")}
        </Link>
      </div>
    );
  const param = (name: string, max: number) => (typeof sp[name] === "string" ? (sp[name] as string).slice(0, max) : "");
  const group = g.groups.includes(param("group", 100)) ? param("group", 100) : "";
  const variant = g.variants.includes(param("variant", 50)) ? param("variant", 50) : "";
  const filter = { group: group || undefined, variant: variant || undefined, all: param("all", 1) === "1" };
  return (
    <Voter
      cards={deck(user, g, filter)}
      progress={progress(user, g, filter)}
      filter={{ group, variant, all: filter.all }}
      groups={g.groups}
      variants={g.variants}
      galleryLabel={t(
        `Galerie vom ${g.generated ? formatDate(locale, Date.parse(g.generated), config.timeZone()) : "?"} · ${g.commitShort}`,
        `Gallery of ${g.generated ? formatDate(locale, Date.parse(g.generated), config.timeZone()) : "?"} · ${g.commitShort}`,
      )}
      login={user.login}
    />
  );
}
