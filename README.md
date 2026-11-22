# flowplan-vote

A small, self-hosted web service to vote on [Flowplan](https://github.com/yannicschuller/flowplan)'s nightly UI gallery ([gallery.flowplan.org](https://gallery.flowplan.org)) – Tinder-style. Sign in with GitHub, then swipe through the screenshots one at a time: **👍** (right), **👎** (left) or **skip** (up), with an optional short comment. The votes stay in a SQLite database; [flowplan-admin](https://github.com/yannicschuller/flowplan-admin) reads them through the [admin API](#admin-api) and turns the 👎 scenes and their comments into a ready-to-paste prompt for Claude Code.

The Flowplan server itself is not involved. Interface in German and English.

## How it works

### The gallery

The service fetches `${GALLERY_URL}/manifest.json` on the server and caches it for ten minutes (a failed fetch keeps serving the last good copy and is retried after a minute). It uses these fields of the manifest (`flowplan/scripts/gallery/compare.ts`):

- top level: `generated`, `commit`, `commitShort`, `version`, `groups`, `variants`, `shots`;
- per shot: `scene`, `group`, `title`, `path`, `variant` (`desktop-light`, `desktop-dark`, `phone-light`, `phone-dark`), `file`, `thumb` (relative to `GALLERY_URL`), `width`, `height`, `hash` (SHA-256 of the pixels), `error`.

Shots with `error`, without `file` or `hash`, or with a `file` that is not a plain relative path are left out. Images are loaded by the browser straight from the gallery: the CSP's `img-src` allows `'self'`, `data:` and the gallery's origin – nothing else external.

### Votes and the deck

A vote is one verdict – `up`, `down` or `skip` – of one person on one **image**: scene + variant + pixel hash. Voting the same image again replaces the vote. Comments are optional, at most 500 characters, shown only as text.

The **deck** (what you get to see) is every shot of the current gallery on whose current image you have no vote yet: shots never voted on, and shots whose `hash` changed since your last vote on that scene and variant (marked "Changed · before 👎"). "Show all" brings back the voted ones too, with your vote on the card. Filters: gallery group and variant.

A vote sent just before a new gallery run still finds its image: the last three runs seen are kept in memory.

**Reset by the maintainer**: flowplan-admin can dismiss a vote (or all of a person's votes) through the [admin API](#admin-api). A dismissed vote counts nowhere – not in the summary, the scenes, the prompt or the export – and the deck treats its image as unvoted, so it comes back, marked "Your earlier vote was reset". Voting it again makes it a normal vote (the same row, the dismissal cleared). The maintainer can restore a dismissed vote; it then counts again and the image leaves the deck.

### Voting screen

- One screenshot, as large as the screen allows (desktop and phone), with title, scene id, group, variant (Desktop/Phone · light/dark) and the progress (`37 / 412`). The next two images are already loaded in the stack behind, one more is preloaded.
- **Swipe** (pointer events – touch, pen and mouse): right 👍, left 👎, up skip. The card follows the finger, tilts, gets a green or red tint and a stamp; past the threshold (a quarter of the width, a fifth of the height, or a quick flick) it flies out, otherwise it springs back.
- **Buttons** for back (and forward, after going back), 👎, skip, 👍 and comment, each with a short label under it (and its key on devices with a mouse), with accessible names.
- **Help**: "How it works" – what the gallery is, the legend of buttons, swipes and keys, and the rules (changed screens come back, the maintainer sees votes with the GitHub name, "My votes"). It opens by itself on the first visit (remembered in `localStorage`, else once per session) and any time from the "Help" button or `?`.
- **Keys**: `↑`/`K` 👍, `↓`/`J` 👎, `→`/`L` skip, `C` comment, `←`/`Z` back, `Shift`+`→`/`X` forward, `Enter` full image (also double-click), `?` help. `Esc` leaves the comment field and keeps the text.
- **Comment** before the verdict or after it ("Add a comment" under the buttons, saved at once). A comment written before the verdict is a draft of that card: it goes with the card's verdict even when the field was closed (the comment button then shows a dot and is named "Comment (draft)"), and it is gone after the vote – the next card never shows the old text.
- **Back** (`←`/`Z`) shows the previous card again, with your verdict on it ("Your vote: 👎") and your comment loaded as its draft; pressing it again goes further back (up to 50 cards). Nothing is deleted: the vote stays saved until you vote on that card again, which replaces verdict and comment (it still counts once). From a card you went back to, voting replaces the vote and moves on; **Forward** (`Shift`+`→`/`X`, shown next to Back only while there are cards you went back over) moves on without changing it – nothing is sent, unless you edited the comment: then it is saved with the same verdict ("Comment saved"). Each card keeps its own draft meanwhile, also the one you went back from. At the first card you never voted on, Forward is gone.
- **Offline**: votes go out at once; when the network is gone they wait in a queue (memory and `localStorage`, per person) and are sent again when the browser is back online or every 20 seconds. One entry per image, so the last change wins.
- The verdict is announced to screen readers (`role="status"`); focus states are visible; with `prefers-reduced-motion` the cards don't move.
- Empty deck: "Alles bewertet – die nächste Galerie kommt heute Nacht".

**My votes** (`/mine`): every own vote, newest first, filterable by verdict, comment, group, variant and text; change the verdict, edit the comment, delete (two steps – the image then comes back into the deck). Votes reset by the maintainer are not listed (they count nowhere); a note says how many there are and that their images are back in the deck.

### Who can vote

`VOTE_ALLOWED_LOGINS` has two modes:

- **List mode** – GitHub logins, comma-separated, case-insensitive: only they can vote. Empty means nobody – the sign-in page says so.
- **Open mode** – `VOTE_ALLOWED_LOGINS=*`: everyone who signs in with a GitHub account can vote. Against throwaway accounts, an account must be at least `VOTE_MIN_ACCOUNT_AGE_DAYS` old (default 30; `0` switches the check off). The age comes from `created_at` in the `GET /user` answer the sign-in reads anyway – no extra request, no extra scope – and is not stored. A younger account sees "Account too new" with the number of days.

In both modes the logins in `VOTE_BLOCKED_LOGINS` (comma-separated, case-insensitive) can never vote, and every person is rate-limited (see [Privacy and security](#privacy-and-security)). Everyone refused sees "No access" (or "Account too new") after signing in, and **nothing is stored about them** (no account, no session). The list and the block list are checked on every request: a login taken off the list, a blocked login, or every non-listed login when open mode is switched off, loses access at once. The account age is checked at sign-in only (an account only gets older).

## Admin API

For flowplan-admin (server to server): every request needs `Authorization: Bearer <VOTE_ADMIN_TOKEN>`, compared in constant time. Without a token configured (or with one shorter than 24 characters) every path answers **404**; a missing or wrong token answers **401** (rate-limited per hashed address). JSON, no CORS headers, `Cache-Control: no-store`. Times in answers are ISO 8601 strings (`createdAt`, `lastVoteAt`, `latestVoteAt`, `galleryGenerated`, `dismissedAt`); the `since` parameter is milliseconds since 1970. The reads are `GET` (another method answers 405); the dismiss and restore actions are `POST` with a JSON body (at most 4 KB). Errors are `{ "error": "<code>", "message": "…" }`.

**Dismissed votes** (reset by the maintainer, see [Votes and the deck](#votes-and-the-deck)) count nowhere: `/summary`, `/scenes`, `/prompt` and `/export` leave them out, and so does `/votes` unless asked with `dismissed=include|only`.

### `GET /api/admin/summary`

```jsonc
{
  "gallery": { "generated": "2026-11-19T02:00:00.000Z", "commit": "<sha>", "commitShort": "a1b2c3d", "version": "1.42.0", "shots": 412 }, // null when the gallery is unreachable
  "totals": { "up": 120, "down": 31, "skip": 9, "comments": 22, "voters": 2, "downVoters": 2 },
  "latestVoteAt": "2026-11-19T06:40:00.000Z", // null without votes
  "byGroup": [{ "group": "Pages", "up": 30, "down": 5, "skip": 1, "voters": 2, "downVoters": 1 }] // in the gallery's group order
}
```

Totals count all stored votes (all gallery runs). `up`, `down`, `skip` count votes; `voters` counts distinct people with any vote, `downVoters` distinct people with at least one 👎 (in `totals` and per group).

### `GET /api/admin/votes?verdict=up|down|skip&group=&scene=&user=&dismissed=exclude|include|only&since=<ms>&limit=≤1000&cursor=`

```jsonc
{
  "votes": [{ "id": 7, "userId": 3, "login": "yannicschuller", "scene": "home", "group": "Pages", "title": "Home", "variant": "phone-dark",
              "hash": "…", "galleryGenerated": "…", "commit": "<sha>", "version": "1.42.0", "verdict": "down",
              "comment": "Tab bar cut off", "createdAt": "2026-11-19T06:40:00.000Z", "current": true,
              "dismissed": false, "dismissedAt": null, "dismissedBy": null }],
  "nextCursor": "1763534400000.7" // opaque; null on the last page
}
```

Newest first (`createdAt`, then `id`). `limit` defaults to 100 (1 … 1000). `since` keeps votes with `createdAt >= since`. `current`: the vote's `hash` equals the current gallery's hash for its scene and variant. Pass `nextCursor` as `cursor` for the next page. A changed vote (new verdict or comment) gets a new `createdAt`.

`user` keeps one person's votes: a login (case-insensitive) or, when no login matches and the value is all digits, the account id (`userId`); an unknown person answers **404** `unknown_user`. `dismissed`: `exclude` (default) leaves dismissed votes out, `include` lists them too, `only` lists only them. `userId` is this service's account id (not the GitHub id). `dismissed`, `dismissedAt` (ISO) and `dismissedBy` (the admin as flowplan-admin named them) describe a reset; `null` while the vote counts.

### `GET /api/admin/voters`

```jsonc
{
  "voters": [{ "userId": 3, "login": "yannicschuller", "name": "Yannic", "votes": 412, "up": 300, "down": 90, "skip": 22,
               "comments": 40, "dismissed": 2, "lastVoteAt": "2026-11-19T06:40:00.000Z" }]
}
```

Everyone with at least one vote (also with only dismissed ones), most votes first, then by login – for flowplan-admin's person filter. `votes`, `up`, `down`, `skip`, `comments` and `lastVoteAt` count only votes that count; `dismissed` counts the dismissed ones (`lastVoteAt` is `null` when there are none that count). For the admin only: logins and names never go into the prompt.

### `POST /api/admin/votes/<id>/dismiss` · `POST /api/admin/votes/<id>/restore`

```jsonc
// dismiss: body { "by": "maintainer@example.org" } – who dismisses, required, one line, at most 200 characters
// restore: body {} (nothing needed)
{ "vote": { /* as in /votes */ }, "changed": true }
```

Dismiss: the vote counts nowhere and its image is back in the person's deck. Restore: it counts again. Both are idempotent – dismissing a dismissed vote keeps its first `dismissedAt`/`dismissedBy`, restoring a counting vote changes nothing; `changed` says whether something changed. An unknown id answers **404** `not_found`; a missing or too long `by` **400** `invalid_by`. Voting the image again (the person) clears a dismissal as well.

### `POST /api/admin/voters/<login or id>/dismiss` · `POST /api/admin/voters/<login or id>/restore`

```jsonc
// dismiss: body { "by": "maintainer@example.org", "scene": "home" }   // scene optional
{ "user": { "userId": 3, "login": "anna" }, "scene": "home", "dismissed": 2, "dismissedAt": "2026-11-21T10:00:00.123Z" }
// restore: body { "scene": "home", "dismissedAt": "2026-11-21T10:00:00.123Z" }   // both optional
{ "user": { "userId": 3, "login": "anna" }, "scene": "home", "restored": 2 }
```

Dismiss every vote of one person that still counts – all runs, or only one scene – with one shared `dismissedAt` (`null` when nothing was left to dismiss). Restore brings back the person's dismissed votes: all, only one scene, and/or only the batch with that `dismissedAt` (to undo exactly one "dismiss all"). The person is matched as in `/votes?user=`; unknown: **404** `unknown_user`. Idempotent: repeating either answers `0`.

### `GET /api/admin/scenes`

```jsonc
{
  "scenes": [{ "scene": "home", "group": "Pages", "title": "Home", "up": 3, "down": 5, "skip": 0, "comments": 2,
               "voters": 6, "upVoters": 2, "downVoters": 4, "skipVoters": 0,
               "lastVerdict": "down", "lastVoteAt": "2026-11-19T06:40:00.000Z", "current": true,
               "file": "shots/home--desktop-light.png", "thumb": "shots/home--desktop-light.png",
               "history": [{ "galleryGenerated": "2026-11-18T02:00:00.000Z", "commitShort": "9f8e7d6", "up": 1, "down": 3 }] }]
}
```

One entry per voted scene, sorted by 👎 votes (then latest vote). `up`, `down`, `skip` count votes (one per person and image, so a person can add several per scene – one per variant); `voters` counts the distinct people with any vote on the scene, `upVoters`/`downVoters`/`skipVoters` those with at least one vote of that verdict (a person with 👍 on desktop and 👎 on phone is in both). `group`, `title` and `lastVerdict` come from the newest vote; `current` means the newest vote is on an image the current gallery still shows. `file` and `thumb` (relative to `GALLERY_URL`) are the current gallery's `desktop-light` shot of the scene, else its first variant; both are left out when the scene is no longer in the gallery. `history` is the trend: 👍/👎 per gallery run, oldest first.

### `GET /api/admin/prompt?scope=current|all&group=&includeUp=0|1`

```jsonc
{ "prompt": "# Design-Feedback aus flowplan-vote (Galerie vom 19. Nov. 2026, Commit a1b2c3d)\n…", "scenes": 4 }
```

A German Markdown instruction for Claude Code: per 👎 scene the scene id, group, title, the variants voted down, the share of voters (`- 👎: 4 von 6 Bewertenden (67 %)` – distinct people with a 👎 out of the distinct people with a 👍 or 👎 on the scene, in scope), the image links (`${GALLERY_URL}/<file>`) and the comments of the 👎 votes verbatim as quotes with their variant. The 👎 scenes are ranked by that share, then by the number of 👎 voters, then in the gallery's order. The prompt contains **no logins or names** – only counts – since in open mode they are strangers' personal data (the `/votes` list and `/export` still carry `login`, for the admin only). `scope=current` (default) only counts votes on the current images; `scope=all` every vote. `group` limits it to one group. `includeUp=1` adds the 👍 scenes without any 👎 as "Gefällt (nicht anfassen)". It ends with: "Bitte wie bei /design-review: Screenshots ansehen, Befunde mit Vorschlägen auflisten und mich fragen, was umgesetzt wird – nichts ändern vor meinem OK." `scenes` is the number of 👎 scenes.

### `GET /api/admin/export?format=csv|json`

Every vote that counts (not dismissed; fields as in `/votes`, newest first) as a download (`Content-Disposition: attachment`). JSON: `{ "votes": [...] }` (the default). CSV: a header line, RFC 4180 quoting, CRLF; cells starting with `= + - @` get a leading `'` so spreadsheets don't run them.

## Privacy and security

- No tracking, no analytics, no external fonts, scripts or CDNs.
- Cookies: the session (`fv_session`, httpOnly, SameSite=Lax, Secure under https, 30 days; the database keeps only its SHA-256; signing out deletes it); during sign-in a ten-minute `fv_oauth` cookie for the OAuth `state`; the language cookie `fv_lang` only after the visitor switches the language. `localStorage` holds unsent votes only while offline.
- Sign-in reads `GET /user` once with the user's OAuth token; the token is not stored. Stored per allowed user: GitHub id, login and name (the account's `created_at` is only compared, never stored). Nothing is stored about refused sign-ins. A vote reset by the maintainer keeps when and by whom (the identifier flowplan-admin sends) until it is restored or voted again.
- IP addresses are never stored: sign-in and wrong admin tokens are rate-limited by a daily rotating HMAC of the address (`ipKey()`). Votes (and changes, undos) are limited per user (180 per minute, 1,000 per hour, 5,000 per day), the deck to 120 loads per minute; over the limit the API answers 429. Request bodies are size-limited.
- CSRF: every writing request must carry an `Origin` (or, without it, a `Referer`) equal to the origin of `VOTE_URL`, else 403; plus SameSite=Lax.
- A strict Content Security Policy (`proxy.ts`): scripts only with the per-request nonce (`strict-dynamic`), styles only from the stylesheet, no inline scripts or style attributes, images only from this site and the gallery, no framing.

## Environment variables

| Variable | Required | Meaning |
| --- | --- | --- |
| `VOTE_URL` | yes | The public base URL, e.g. `https://vote.flowplan.org` (Secure cookies, OAuth callback, Origin check). |
| `VOTE_ALLOWED_LOGINS` | yes | Who may vote: GitHub logins, comma-separated, case-insensitive (list mode), or `*` for everyone with a GitHub account (open mode). Empty = nobody. |
| `VOTE_BLOCKED_LOGINS` | – | Logins that may never vote, in either mode, comma-separated, case-insensitive. Takes effect at once, also for existing sessions. |
| `VOTE_MIN_ACCOUNT_AGE_DAYS` | – | Open mode only: minimum age of a GitHub account in days to sign in (default `30`; `0` = no check). |
| `VOTE_GITHUB_CLIENT_ID` | yes | The GitHub App's client id (sign-in). |
| `VOTE_GITHUB_CLIENT_SECRET` | yes | The GitHub App's client secret. |
| `VOTE_ADMIN_TOKEN` | for flowplan-admin | Bearer token of the admin API, at least 24 characters (`openssl rand -hex 32`). The same value goes into flowplan-admin. Unset: admin API off (404). |
| `GALLERY_URL` | – | The UI gallery (default `https://gallery.flowplan.org`). |
| `VOTE_DATA_DIR` | – | Directory for the SQLite database and the generated key (default `./data`; `/app/data` in the image). |
| `VOTE_TIME_ZONE` | – | IANA time zone for dates on the pages and in the prompt (default `Europe/Berlin`). |
| `PORT` | – | Port of the server (default 3000). |
| `VOTE_GITHUB_API` | – | Tests only: base URL of a GitHub mock (the OAuth code exchange goes there too). |

Secrets come only from the environment – see [`.env.example`](.env.example).

## GitHub App

Sign-in uses a GitHub App's **user authorization** only – the App needs no permissions and is never installed on a repository. Create it under Settings → Developer settings → GitHub Apps → New:

1. **GitHub App name**: e.g. "Flowplan Vote"; **Homepage URL**: `<VOTE_URL>`.
2. **Callback URL**: `<VOTE_URL>/api/auth/callback` (e.g. `https://vote.flowplan.org/api/auth/callback`). "Request user authorization (OAuth) during installation" **off**; "Expire user authorization tokens" as you like (the token is used once).
3. **Webhook**: **off** (uncheck "Active").
4. **Permissions**: none (account permissions are not needed – `GET /user` works without).
5. **Where can this GitHub App be installed?**: for open mode (`VOTE_ALLOWED_LOGINS=*`) choose **"Any account"** (public) – other people's GitHub accounts must be able to authorize the App; with no permissions and no installation that exposes nothing. "Only on this account" may be enough for list mode with only your own login.
6. Create it, copy the **Client ID** (→ `VOTE_GITHUB_CLIENT_ID`) and generate a **client secret** (→ `VOTE_GITHUB_CLIENT_SECRET`). No private key, no App ID needed.

## Deploy (Coolify)

The image is built on every push to main and published as `ghcr.io/yannicschuller/flowplan-vote:latest` (and `:sha-…`), for linux/amd64 and linux/arm64.

1. In Coolify, create a resource from the image (or the Dockerfile), port 3000, domain `vote.flowplan.org` (DNS: a record pointing to the Coolify server).
2. Add a persistent volume at `/app/data`.
3. Set the environment variables above; `VOTE_URL` must be the public **https** URL.
4. Coolify's reverse proxy terminates TLS; the healthcheck is `GET /api/health` → `{"service":"flowplan-vote","status":"ok"}`.
5. Optional: the repository secrets `COOLIFY_WEBHOOK` and `COOLIFY_TOKEN` let the Docker workflow roll out every new `:latest`.
6. In flowplan-admin set `VOTE_URL` and the same `VOTE_ADMIN_TOKEN`.

## Local development

```sh
npm ci
cp .env.example .env.local   # fill in what you need
npm run dev                  # http://127.0.0.1:3000
```

Checks (all must be green before a commit):

```sh
npm run typecheck
npm test            # unit and route tests, no network (gallery and GitHub are local mocks)
npm run build
```

Browser smoke test (Playwright, after `npm run build`; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an installed Chromium):

```sh
npm run test:browser
SCREENSHOTS_DIR=/tmp/shots npm run test:browser   # also screenshots of the voting screen and pages
```

It starts the standalone build with a temporary data directory, a fake gallery (`tests/gallery-mock.ts`, generated PNG screenshots) and sessions created directly in the database – no GitHub, no real account.

## License

[AGPL-3.0-only](LICENSE), like Flowplan.
