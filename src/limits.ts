// Fixed-window per-second rate gate. Bounded concurrency is handled in
// send.ts directly (a Set-capped in-flight pool over the CSV stream) rather
// than here — see the note at the top of send.ts for why.
export function createRateLimiter(ratePerSecond: number): () => Promise<void> {
  let windowStart = Date.now();
  let countInWindow = 0;

  return async function acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        countInWindow = 0;
      }
      if (countInWindow < ratePerSecond) {
        countInWindow++;
        return;
      }
      await sleep(windowStart + 1000 - now);
    }
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}
