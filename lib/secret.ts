// Hashes and the tool's own HMAC key (for the rotating key of anonymous
// rate limits). The key is random and created once in the data directory –
// nothing secret has to be configured for it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const cache = globalThis as unknown as { voteSecret?: { dir: string; key: Buffer } };

export function secretKey(): Buffer {
  const dir = config.dataDir();
  const cached = cache.voteSecret;
  if (cached && cached.dir === dir) return cached.key;
  mkdirSync(dir, { recursive: true });
  const file = join(/*turbopackIgnore: true*/ dir, "secret.key");
  let key: Buffer;
  if (existsSync(file)) key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  else {
    key = randomBytes(32);
    writeFileSync(file, key.toString("hex"), { mode: 0o600 });
  }
  cache.voteSecret = { dir, key };
  return key;
}

export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const hmac = (purpose: string, value: string) => createHmac("sha256", secretKey()).update(`${purpose}\0${value}`).digest("base64url");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

// Constant-time comparison of two strings (via their hashes, so lengths don't leak).
export function safeEqual(a: string, b: string) {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
