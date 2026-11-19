// Small helpers for route handlers on the standard Request and Response, so
// the handlers can be tested without Next.js.
import { config } from "./config";
import { RateLimitError } from "./rate-limit";

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra: Record<string, unknown> = {}) {
    super(message ?? code);
  }
}

const SECURITY_HEADERS = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };

export function json(data: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...init.headers },
  });
}

const rateLimitMessage = (seconds: number) =>
  `Zu viele Anfragen – bitte warte ${seconds} Sekunden. / Too many requests – please wait ${seconds} seconds.`;

// Runs a handler and turns known errors into JSON answers.
export async function handle(fn: () => Promise<Response> | Response): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message, ...error.extra }, { status: error.status });
    if (error instanceof RateLimitError)
      return json(
        { error: "rate_limited", message: rateLimitMessage(error.retryAfter), retryAfter: error.retryAfter },
        { status: 429, headers: { "Retry-After": String(error.retryAfter) } },
      );
    console.error(error);
    return json({ error: "internal", message: "Internal error." }, { status: 500 });
  }
}

export function redirect(location: string, cookies: string[] = []) {
  const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
  for (const c of cookies) headers.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers });
}

export function cookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}
export function setCookie(name: string, value: string, opts: { maxAge?: number; path?: string } = {}) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? "/"}`,
    opts.maxAge !== undefined ? `Max-Age=${opts.maxAge}` : "",
    "HttpOnly",
    "SameSite=Lax",
    config.https() ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

// The client's address, only ever used through ipKey() for the rate limits
// of the sign-in and of wrong admin tokens: the first hop of X-Forwarded-For (the reverse
// proxy sets it), else X-Real-IP. Never used for any other decision.
export function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

// CSRF: every writing request must come from this site's pages – its
// Origin header (or, without one, its Referer's origin) must be the origin
// of VOTE_URL. Together with SameSite=Lax cookies.
export function requireSameOrigin(request: Request) {
  const own = config.publicOrigin();
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    if (origin === own) return;
    throw new HttpError(403, "cross_origin", "Cross-origin request refused.");
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      if (new URL(referer).origin === own) return;
    } catch {
      // fall through
    }
  }
  throw new HttpError(403, "cross_origin", "Cross-origin request refused.");
}

// The body, at most `limit` bytes (also when Content-Length lies).
export async function readBody(request: Request, limit: number): Promise<Buffer> {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new HttpError(413, "too_large", "Request too large.");
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new HttpError(413, "too_large", "Request too large.");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export const isForm = (request: Request) => (request.headers.get("content-type") || "").startsWith("application/x-www-form-urlencoded");

// A JSON object or an HTML form (urlencoded) as a plain record of strings and values.
export async function readInput(request: Request, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const body = (await readBody(request, limit)).toString("utf8");
  if (isForm(request)) return Object.fromEntries(new URLSearchParams(body));
  try {
    const value = body ? JSON.parse(body) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Invalid JSON body.");
  }
}

export const str = (v: unknown, max = 10_000) => (typeof v === "string" ? v.slice(0, max) : "");
export function int(v: unknown) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d{1,12}$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) ? n : null;
}

// Only paths of this site (no open redirects).
export function safeNext(next: unknown, fallback = "/") {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.length > 500) return fallback;
  return next;
}
// Adds ?key=value to a path of this site (for the result of a form).
export function withParam(path: string, key: string, value: string) {
  const u = new URL(path, "http://x");
  u.searchParams.set(key, value);
  return u.pathname + u.search + u.hash;
}
