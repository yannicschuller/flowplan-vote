// Error codes (?error=… on the sign-in page, `error` in API answers) as a sentence.
import type { T } from "./i18n";

export function errorMessage(code: string, t: T): string {
  switch (code) {
    case "github_failed":
      return t("GitHub hat nicht wie erwartet geantwortet. Versuch es noch einmal.", "GitHub did not answer as expected. Please try again.");
    case "rate_limited":
      return t("Zu viele Anfragen – bitte warte einen Moment.", "Too many requests – please wait a moment.");
    case "signed_out":
      return t("Bitte melde dich an.", "Please sign in.");
    case "not_allowed":
      return t("Dieses GitHub-Konto darf hier nicht bewerten.", "This GitHub account can't vote here.");
    case "github_off":
      return t("Die Anmeldung mit GitHub ist auf diesem Server nicht eingerichtet.", "Sign-in with GitHub is not set up on this server.");
    case "github_state":
      return t("Die Anmeldung ist abgelaufen oder kam nicht von hier. Versuch es noch einmal.", "The sign-in expired or did not start here. Please try again.");
    case "gallery_unavailable":
      return t("Die Galerie ist gerade nicht erreichbar.", "The gallery is not reachable right now.");
    case "unknown_shot":
      return t("Dieses Bild ist nicht mehr in der Galerie – lade die Seite neu.", "This image is no longer in the gallery – reload the page.");
    case "comment_too_long":
      return t("Der Kommentar ist zu lang (höchstens 500 Zeichen).", "The comment is too long (at most 500 characters).");
    case "not_found":
      return t("Nicht gefunden.", "Not found.");
    default:
      return t("Das hat nicht geklappt.", "That didn't work.");
  }
}
