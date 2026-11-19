// GitHub on plain fetch for the sign-in: timeouts and clear errors.
// VOTE_GITHUB_API points it at a local mock server in tests.
export class GitHubError extends Error {
  constructor(public status: number, public path: string, message: string) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

export async function githubFetch(url: string, init: RequestInit = {}, timeoutMs = TIMEOUT_MS): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "flowplan-vote");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  if (!headers.has("Accept")) headers.set("Accept", "application/vnd.github+json");
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  try {
    return await fetch(url, { ...init, headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const reason = (error as Error)?.name === "TimeoutError" ? `timed out after ${timeoutMs / 1000} s` : (error as Error)?.message || "network error";
    throw new GitHubError(0, path, `GitHub ${init.method || "GET"} ${path}: ${reason}`);
  }
}
