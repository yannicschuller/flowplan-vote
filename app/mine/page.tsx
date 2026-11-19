import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { pageT, pageUser } from "@/lib/page";
import { galleryOrNull } from "@/lib/gallery";
import { myVotes } from "@/lib/votes";
import { config } from "@/lib/config";
import { MyVotes } from "@/components/my-votes";

export const dynamic = "force-dynamic";
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await pageT();
  return { title: t("Meine Bewertungen", "My votes") };
}

export default async function Mine() {
  const [{ t }, user] = await Promise.all([pageT(), pageUser()]);
  if (!user) redirect("/login?next=%2Fmine");
  if (!user.allowed) redirect("/login?error=not_allowed");
  const g = await galleryOrNull();
  const votes = myVotes(user, g);
  const groups = [...new Set([...(g?.groups ?? []), ...votes.map((v) => v.group)])].filter((x) => votes.some((v) => v.group === x));
  const variants = [...new Set([...(g?.variants ?? []), ...votes.map((v) => v.variant)])].filter((x) => votes.some((v) => v.variant === x));
  return (
    <>
      <div className="page-head">
        <h1>{t("Meine Bewertungen", "My votes")}</h1>
        <p className="lede">
          {t(
            "Alles, was du bewertet hast – neueste zuerst. Ändere das Urteil, ergänze einen Kommentar oder lösch eine Bewertung; gelöschte Bilder kommen zurück in deinen Stapel.",
            "Everything you voted on – newest first. Change the verdict, add a comment or delete a vote; deleted images come back into your deck.",
          )}
        </p>
        {!g && <p className="notice warn">{t("Die Galerie ist gerade nicht erreichbar – Vorschaubilder fehlen.", "The gallery is not reachable right now – previews are missing.")}</p>}
      </div>
      <MyVotes votes={votes} groups={groups} variants={variants} timeZone={config.timeZone()} />
    </>
  );
}
