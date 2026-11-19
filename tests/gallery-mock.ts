// A local stand-in for the UI gallery (gallery.flowplan.org): manifest.json
// in the shape of flowplan/scripts/gallery/compare.ts, and PNG screenshots.
// Tests change the manifest (a new run, a changed hash, a failure) at will.
import { createServer, type Server } from "node:http";
import { screenshotPng } from "./png";

export type FakeShot = {
  scene: string;
  group: string;
  title: string;
  path: string;
  variant: string;
  file: string;
  thumb: string;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  hash: string;
  error?: string;
  pageErrors: string[];
  ms: number;
};

export const VARIANTS = ["desktop-light", "desktop-dark", "phone-light", "phone-dark"] as const;
const SIZE = { desktop: [1440, 900], phone: [390, 844] } as const;

export function fakeShot(scene: string, group: string, title: string, variant: string, hash = `${scene}-${variant}-h1`): FakeShot {
  const [w, h] = SIZE[variant.startsWith("phone") ? "phone" : "desktop"];
  const file = `shots/${scene}--${variant}.png`;
  return { scene, group, title, path: `/${scene}`, variant, file, thumb: file, width: w, height: h, thumbWidth: w, thumbHeight: h, hash, pageErrors: [], ms: 100 };
}

export function fakeManifest(shots: FakeShot[], run = { generated: "2026-11-19T02:00:00.000Z", commit: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", version: "1.42.0" }) {
  return {
    format: 1,
    generated: run.generated,
    commit: run.commit,
    commitShort: run.commit.slice(0, 7),
    branch: "main",
    version: run.version,
    seconds: 120,
    server: "http://127.0.0.1:3999",
    variants: [...VARIANTS],
    groups: ["Pages", "Documents & editor", "Databases", "Dialogs", "Settings", "Auth"],
    shots,
    changes: { previous: null, changed: [], added: [], removed: [] },
  };
}

// A small default gallery: three scenes in two groups, all four variants,
// plus one shot that failed (with `error`).
export function defaultShots() {
  const scenes: [string, string, string][] = [
    ["home", "Pages", "Home"],
    ["document-editor", "Documents & editor", "Document editor"],
    ["settings-profile", "Settings", "Settings · Profile"],
  ];
  const shots = scenes.flatMap(([scene, group, title]) => VARIANTS.map((v) => fakeShot(scene, group, title, v)));
  shots.push({ ...fakeShot("broken", "Dialogs", "Broken dialog", "desktop-light"), error: "Timeout" });
  return shots;
}

export async function startGalleryMock(options: { listen?: number; setEnv?: boolean } = {}) {
  let manifest: unknown = fakeManifest(defaultShots());
  let status = 200;
  let requests = 0;
  const images = new Map<string, Buffer>();
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://x");
    if (url.pathname === "/manifest.json") {
      requests++;
      if (status !== 200) {
        res.writeHead(status, { "content-type": "text/plain" });
        return res.end("down");
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(manifest));
    }
    const m = /^\/shots\/([\w-]+)--((desktop|phone)-(light|dark))\.png$/.exec(url.pathname);
    if (m) {
      let png = images.get(url.pathname);
      if (!png) {
        const phone = m[3] === "phone";
        const [w, h] = SIZE[phone ? "phone" : "desktop"];
        png = screenshotPng(w, h, { dark: m[4] === "dark", phone, seed: [...m[1]].reduce((a, ch) => a + ch.charCodeAt(0), 0) });
        images.set(url.pathname, png);
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=3600" });
      return res.end(png);
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(options.listen ?? 0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  if (options.setEnv !== false) process.env.GALLERY_URL = base;
  return {
    base,
    server,
    setManifest: (m: unknown) => {
      manifest = m;
    },
    setStatus: (s: number) => {
      status = s;
    },
    requests: () => requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
