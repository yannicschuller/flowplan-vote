import { pageT } from "@/lib/page";
import { config } from "@/lib/config";

export async function SiteFooter() {
  const { t, locale } = await pageT();
  // The website's legal pages, in the visitor's language (/de/…, /en/…).
  const site = `https://flowplan.org/${locale}`;
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <span>{t("Design-Bewertungen für Flowplan – keine Tracker, keine Werbung.", "Design votes for Flowplan – no trackers, no ads.")}</span>
        <span className="spacer" />
        <a href={config.galleryUrl()}>{t("UI-Galerie", "UI gallery")}</a>
        <a href="https://flowplan.org">flowplan.org</a>
        <a href="https://github.com/yannicschuller/flowplan-vote">{t("Quellcode", "Source code")}</a>
        <a href={`${site}/impressum`}>{t("Impressum", "Legal notice")}</a>
        <a href={`${site}/datenschutz`}>{t("Datenschutz", "Privacy")}</a>
      </div>
    </footer>
  );
}
