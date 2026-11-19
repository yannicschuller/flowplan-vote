<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## This repository

- Domain logic lives in `lib/` and works on plain `Request`/`Response`; `app/api/**` only forwards to `lib/routes.ts` (`handle(() => route(request))`). Keep it that way so `tests/` can call it without Next.js.
- The admin API (`lib/admin.ts`, paths `/api/admin/*`) is a contract with flowplan-admin, described in the README. Paths, field names and shapes change only together with flowplan-admin.
- The gallery (`GALLERY_URL`) is read-only: `manifest.json` is fetched on the server and cached (`lib/gallery.ts`); images are shown straight from the gallery's origin (the only external host in the CSP).
- UI texts in German and English side by side: `t("Deutsch", "English")`, German informal "du". Code comments, README and commits in English.
- No inline scripts or style attributes (strict CSP in `proxy.ts`): positions and sizes are set from script through CSS custom properties, never the `style` prop. Comments only as React text (never as HTML), no tracking, no visitor cookies except the session (and the language cookie after an explicit switch), never store IP addresses (use `ipKey()`).
- Only logins in `VOTE_ALLOWED_LOGINS` get an account; nothing is stored about anyone else.
- Secrets only from environment variables – never in code, tests, fixtures or commits; tests use a local gallery mock (`tests/gallery-mock.ts`) and GitHub mock (`tests/github-mock.ts`), never the network.
- Schema changes only as a new numbered migration in `lib/db.ts`.
- Checks: `npm run typecheck`, `npm test`, `npm run build`; the browser smoke test is `npm run test:browser`.
