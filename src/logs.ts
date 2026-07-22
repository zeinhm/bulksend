import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { once } from "node:events";

// Read once at startup: a set of row indices, not email strings, per the
// plan (O(n) in row count, not in email-string bytes).
export function loadCompletedIndices(path: string): Set<number> {
  if (!existsSync(path)) return new Set();
  const indices = new Set<number>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    indices.add((JSON.parse(line) as { index: number }).index);
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
