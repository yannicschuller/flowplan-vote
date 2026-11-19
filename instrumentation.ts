// On every server start: open the database (migrations) and the hourly
// cleanup of expired sessions and rate-limit windows. A failure is logged
// and never keeps the service from starting.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { db } = await import("./lib/db");
    db();
    const { cleanup } = await import("./lib/rate-limit");
    const tick = () => {
      try {
        cleanup();
      } catch (error) {
        console.error("cleanup failed", error);
      }
    };
    tick();
    setInterval(tick, 60 * 60 * 1000).unref?.();
  } catch (error) {
    console.error("Start-up failed:", error);
  }
}
