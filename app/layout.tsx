import type { Metadata, Viewport } from "next";
import "./globals.css";
import { pageLocale } from "@/lib/page";
import { config } from "@/lib/config";
import { translate } from "@/lib/i18n";
import { LocaleProvider } from "@/components/i18n";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";

export async function generateMetadata(): Promise<Metadata> {
  const t = translate(await pageLocale());
  return {
    metadataBase: new URL(config.publicUrl()),
    title: { default: "Flowplan Vote", template: "%s · Flowplan Vote" },
    description: t("Die nächtliche UI-Galerie von Flowplan bewerten – 👍, 👎 oder überspringen.", "Vote on Flowplan's nightly UI gallery – 👍, 👎 or skip."),
    applicationName: "Flowplan Vote",
    icons: { icon: [{ url: "/icon.svg", type: "image/svg+xml" }] },
    robots: { index: false, follow: false },
  };
}
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfbf8" },
    { media: "(prefers-color-scheme: dark)", color: "#16151b" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await pageLocale();
  return (
    <html lang={locale}>
      <body>
        <LocaleProvider locale={locale}>
          <a className="skip-link" href="#main">
            {translate(locale)("Zum Inhalt", "Skip to content")}
          </a>
          <SiteHeader />
          <main id="main">{children}</main>
          <SiteFooter />
        </LocaleProvider>
      </body>
    </html>
  );
}
