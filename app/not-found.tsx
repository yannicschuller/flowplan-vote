import Link from "next/link";
import { pageT } from "@/lib/page";

export default async function NotFound() {
  const { t } = await pageT();
  return (
    <div className="signin card">
      <h1>{t("Nicht gefunden", "Not found")}</h1>
      <p className="muted">{t("Diese Seite gibt es nicht (mehr).", "This page doesn't exist (any more).")}</p>
      <Link className="button" href="/">
        {t("Zum Bewerten", "Back to voting")}
      </Link>
    </div>
  );
}
