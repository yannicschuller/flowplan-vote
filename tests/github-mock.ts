// A local stand-in for the parts of GitHub the sign-in uses: the OAuth code
// exchange and GET /user. Never the network.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { after } from "node:test";

export async function startGitHubMock() {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const oauth = { code: "good-code", user: { id: 4242, login: "Octo-Voter", name: "Octo" } as { id: number; login: string; name: string } };
  const read = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const raw = await read(req);
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method || "GET", path: url.pathname, body });
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/login/oauth/access_token" && req.method === "POST")
      return send(200, body?.code === oauth.code && body?.client_secret === "test-client-secret" ? { access_token: "user-token-xyz" } : { error: "bad_verification_code" });
    if (url.pathname === "/user") return req.headers.authorization === "Bearer user-token-xyz" ? send(200, oauth.user) : send(401, { message: "Bad credentials" });
    return send(404, { message: "Not Found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  process.env.VOTE_GITHUB_API = base;
  process.env.VOTE_GITHUB_CLIENT_ID = "Iv1.test";
  process.env.VOTE_GITHUB_CLIENT_SECRET = "test-client-secret";
  return { base, calls, oauth };
}
