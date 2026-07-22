import { createWriteStream, existsSync, readFileSync, truncateSync } from "node:fs";
import { once } from "node:events";

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
export function loadCompletedIndices(path: string): Set<number> {
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
      indices.add((JSON.parse(line) as { index: number }).index);
    } catch (err) {
      throw new Error(`Corrupt line ${i + 1} in ${path}: ${(err as Error).message}`);
    }
  }
  return indices;
}

export function openAppendLog(path: string): NodeJS.WritableStream {
  return createWriteStream(path, { flags: "a", encoding: "utf8" });
}

export async function appendEntry(ws: NodeJS.WritableStream, entry: unknown): Promise<void> {
  if (!ws.write(JSON.stringify(entry) + "\n")) {
    await once(ws, "drain");
  }
}
