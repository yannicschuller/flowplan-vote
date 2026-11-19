// Labels shared by the server pages and the client components. Client-safe.
import type { T } from "./i18n";

// "desktop-dark" → "Desktop · dunkel"; anything else as it is.
export function variantParts(variant: string) {
  const [device, theme] = variant.split("-");
  return { device: device === "phone" || device === "desktop" ? device : "", theme: theme === "light" || theme === "dark" ? theme : "" };
}
export function variantLabel(t: T, variant: string) {
  const { device, theme } = variantParts(variant);
  if (!device || !theme) return variant;
  return `${device === "phone" ? t("Phone", "Phone") : t("Desktop", "Desktop")} · ${theme === "dark" ? t("dunkel", "dark") : t("hell", "light")}`;
}
export function verdictLabel(t: T, verdict: string) {
  return verdict === "up" ? t("Gefällt mir", "Like") : verdict === "down" ? t("Gefällt mir nicht", "Dislike") : t("Übersprungen", "Skipped");
}
export const verdictEmoji = (verdict: string) => (verdict === "up" ? "👍" : verdict === "down" ? "👎" : "⤼");
