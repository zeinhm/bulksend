import { createWriteStream, existsSync, readFileSync, truncateSync } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";

// Read once at startup: a set of row indices, not email strings, per the
// plan (O(n) in row count, not in email-string bytes).
//
// A hard kill can land mid-`write()`, leaving a torn tail with no closing
// newline. Only newline-terminated lines count as durably recorded: any
// bytes after the last "\n" are discarded from the index set AND truncated
// off the file on disk, so the log self-heals before this run's first
// append (otherwise the next write lands directly after the torn bytes with
// no separator and corrupts what used to be a clean file). A malformed line
// INSIDE the newline-terminated region isn't a torn write — real corruption
// — and stays fatal.
//
// `predicate` decides which entries count as "done, skip on resume" -- e.g.
// failed.ndjson entries with kind "exhausted" should NOT be treated as
// done, since resume is exactly the mechanism that gives them another try.
export function loadCompletedIndices(
  path: string,
  predicate?: (entry: Record<string, unknown> & { index: number }) => boolean,
): Set<number> {
  if (!existsSync(path)) return new Set();

  const buf = readFileSync(path);
  const lastNewline = buf.lastIndexOf(0x0a);
  const completeBytes = lastNewline + 1; // 0 if the file has no newline at all
  const tornBytes = buf.length - completeBytes;

  if (tornBytes > 0) {
    console.warn(
      `Warning: ${path} has ${tornBytes} byte(s) after the last complete line (likely a hard kill mid-write) -- discarding them; that row will be treated as not-yet-processed.`,
    );
    truncateSync(path, completeBytes);
  }

  const indices = new Set<number>();
  const text = buf.subarray(0, completeBytes).toString("utf8");
  const lines = text.length > 0 ? text.split("\n").slice(0, -1) : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown> & { index: number };
      if (!predicate || predicate(entry)) {
        indices.add(entry.index);
      }
    } catch (err) {
      throw new Error(`Corrupt line ${i + 1} in ${path}: ${(err as Error).message}`);
    }
  }
  return indices;
}

export interface AppendLog {
  write(entry: unknown): Promise<void>;
  close(): Promise<void>;
}

// Wraps the raw write stream so a write-time failure (disk full, permission
// revoked mid-run, etc.) surfaces as a rejected promise through write()/
// close() instead of an unhandled "error" event that crashes the process
// outside the normal CLI error path.
export function openAppendLog(path: string): AppendLog {
  const ws = createWriteStream(path, { flags: "a", encoding: "utf8" });
  let streamError: Error | null = null;
  ws.on("error", (err: Error) => {
    streamError = err;
  });

  return {
    async write(entry: unknown): Promise<void> {
      if (streamError) throw streamError;
      if (!ws.write(JSON.stringify(entry) + "\n")) {
        // once(ws, "drain") also rejects if `ws` emits "error" first --
        // Node's events.once() special-cases "error" for any other event
        // it's asked to wait for.
        await once(ws, "drain");
      }
      if (streamError) throw streamError;
    },
    async close(): Promise<void> {
      ws.end();
      await finished(ws);
    },
  };
}
