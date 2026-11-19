"use client";
// Votes are sent at once; when the network is gone (or the server answers
// 5xx/429) they wait in this queue – in memory and in localStorage – and go
// out again when the browser is back online or every 20 seconds. One entry
// per image (scene + variant + hash): a newer change replaces an older one,
// so the server always ends up with the last state.

export type QueueOp = {
  id: number;
  key: string;
  scene: string;
  variant: string;
  hash: string;
  action: "set" | "delete";
  verdict?: "up" | "down" | "skip";
  comment?: string;
};
export type QueueState = { pending: number; offline: boolean; error: string };
type Listener = (state: QueueState) => void;

const STORAGE_KEY = "fv_queue";
const RETRY_MS = 20_000;

export const imageKey = (x: { scene: string; variant: string; hash: string }) => `${x.scene}\u0000${x.variant}\u0000${x.hash}`;

export class VoteQueue {
  private ops: QueueOp[] = [];
  private nextId = 1;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  state: QueueState = { pending: 0, offline: false, error: "" };

  constructor(private owner: string) {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as { owner: string; ops: QueueOp[] } | null;
      if (saved && saved.owner === owner && Array.isArray(saved.ops)) {
        this.ops = saved.ops.filter((op) => op && typeof op.key === "string");
        this.nextId = Math.max(0, ...this.ops.map((op) => op.id)) + 1;
      }
    } catch {
      // storage blocked or broken: the queue lives in memory only
    }
    this.publish();
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(patch: Partial<QueueState> = {}) {
    this.state = { ...this.state, ...patch, pending: this.ops.length };
    try {
      if (this.ops.length) localStorage.setItem(STORAGE_KEY, JSON.stringify({ owner: this.owner, ops: this.ops }));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    for (const l of this.listeners) l(this.state);
  }

  push(op: Omit<QueueOp, "id" | "key">) {
    const key = imageKey(op);
    this.ops = this.ops.filter((o) => o.key !== key);
    this.ops.push({ ...op, key, id: this.nextId++ });
    this.publish();
    void this.flush();
  }

  // Sends the waiting changes in order; stops at the first one that cannot go out now.
  async flush() {
    if (this.running) return;
    this.running = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      while (this.ops.length) {
        const op = this.ops[0];
        let response: Response;
        try {
          response = await fetch("/api/votes", {
            method: op.action === "delete" ? "DELETE" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ scene: op.scene, variant: op.variant, hash: op.hash, verdict: op.verdict, comment: op.comment ?? "" }),
          });
        } catch {
          this.publish({ offline: true });
          this.schedule();
          return;
        }
        if (response.status >= 500 || response.status === 429) {
          this.publish({ offline: response.status !== 429 });
          this.schedule();
          return;
        }
        let error = "";
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string };
          error = body.error || "failed";
        }
        // Done (or refused for good): drop it unless a newer change replaced it meanwhile.
        this.ops = this.ops.filter((o) => o.id !== op.id);
        this.publish({ offline: false, error: error || this.state.error });
        if (error === "signed_out") return;
      }
    } finally {
      this.running = false;
    }
  }

  clearError() {
    this.publish({ error: "" });
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), RETRY_MS);
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.listeners.clear();
  }
}
