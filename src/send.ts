import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import type { Provider, Recipient, SendResult } from "./provider.js";
import { createRateLimiter } from "./limits.js";
import { appendEntry, loadCompletedIndices, openAppendLog } from "./logs.js";

const SUBJECT_TEMPLATE = "A quick note just for {{name}}";
const BODY_TEMPLATE = [
  "Hi {{name}},",
  "",
  "Thanks for being part of our community -- we've got something we think",
  "you'll like this week.",
  "",
  "-- The Team",
].join("\n");

function compileTemplate(template: string): (name: string) => string {
  const parts = template.split("{{name}}");
  return (name: string): string => parts.join(name);
}

export interface SendOptions {
  csvPath: string;
  sentLogPath: string;
  failedLogPath: string;
  concurrency: number;
  ratePerSecond: number;
  dryRun: boolean;
  provider: Provider;
  // Hard cap on how many CSV rows are even read this run. Required and
  // enforced whenever dryRun is false -- SMTP mode must never be able to
  // reach the full recipient list.
  limit?: number;
}

const MAX_ATTEMPTS = 3;

async function sendWithRetry(
  provider: Provider,
  recipient: Recipient,
  subject: string,
  body: string,
  acquireRateSlot: () => Promise<void>,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // Every attempt is a real request against the provider, so every
    // attempt -- not just the first -- counts against the rate cap.
    // Otherwise a retry storm can push actual request rate above --rate.
    await acquireRateSlot();
    const result: SendResult = await provider.send(recipient, subject, body);
    if (result.status === "sent") return { ok: true };
    if (result.status === "permanent_failure") return { ok: false, reason: result.reason };
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, result.retryAfterMs));
      continue;
    }
    return { ok: false, reason: `429 rate-limited, retries exhausted after ${MAX_ATTEMPTS} attempts` };
  }
  throw new Error("unreachable");
}

// Fast streaming line count so the progress line can show a real
// "remaining" figure. Never buffers rows, just counts newlines.
async function countDataRows(csvPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let newlineCount = 0;
    const rs = createReadStream(csvPath, { encoding: "utf8" });
    rs.on("data", (raw: string | Buffer) => {
      const chunk = typeof raw === "string" ? raw : raw.toString("utf8");
      let pos = 0;
      for (;;) {
        const idx = chunk.indexOf("\n", pos);
        if (idx === -1) break;
        newlineCount++;
        pos = idx + 1;
      }
    });
    rs.on("end", () => resolve(Math.max(newlineCount - 1, 0))); // minus header
    rs.on("error", reject);
  });
}

export async function send(options: SendOptions): Promise<void> {
  const { csvPath, sentLogPath, failedLogPath, concurrency, ratePerSecond, dryRun, provider, limit } = options;

  // Belt-and-suspenders: the CLI already refuses --smtp without --limit,
  // but this is the function that actually talks to a real transport, so
  // the invariant is enforced here too, not just at the flag-parsing layer.
  if (!dryRun && (limit === undefined || limit <= 0)) {
    throw new Error("Refusing to run a non-dry-run send without a positive limit.");
  }

  const renderSubject = compileTemplate(SUBJECT_TEMPLATE);
  const renderBody = compileTemplate(BODY_TEMPLATE);

  const sentIndices = loadCompletedIndices(sentLogPath);
  const failedIndices = loadCompletedIndices(failedLogPath);
  const alreadyDone = sentIndices.size + failedIndices.size;

  const totalRows = await countDataRows(csvPath);
  const effectiveTotal = limit !== undefined ? Math.min(totalRows, limit) : totalRows;

  const sentLog = openAppendLog(sentLogPath);
  const failedLog = openAppendLog(failedLogPath);
  const acquireRateSlot = createRateLimiter(ratePerSecond);

  let sentCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  const startedAt = Date.now();

  function printProgress(final = false): void {
    const elapsedSec = (Date.now() - startedAt) / 1000;
    const processed = sentCount + failedCount;
    const rate = elapsedSec > 0 ? processed / elapsedSec : 0;
    const remaining = Math.max(effectiveTotal - alreadyDone - processed, 0);
    const line = `sent=${sentCount} failed=${failedCount} skipped=${skippedCount} remaining=${remaining} (${rate.toFixed(1)}/s)`;
    process.stdout.write(final ? `${line}\n` : `\r${line}   `);
  }

  const progressTimer = setInterval(printProgress, 500);

  async function processRow(recipient: Recipient): Promise<void> {
    const subject = renderSubject(recipient.name);
    const body = renderBody(recipient.name);
    const outcome = await sendWithRetry(provider, recipient, subject, body, acquireRateSlot);

    if (outcome.ok) {
      await appendEntry(sentLog, { index: recipient.index });
      sentCount++;
    } else {
      await appendEntry(failedLog, { index: recipient.index, email: recipient.email, reason: outcome.reason });
      failedCount++;
    }
  }

  // Bounded in-flight pool: the CSV read pauses once `concurrency` rows are
  // being processed, so memory never scales with file size regardless of
  // how far ahead disk I/O could otherwise run.
  const inFlight = new Set<Promise<void>>();
  const parser = createReadStream(csvPath).pipe(parse({ columns: true }));
  let rowIndex = 0;

  for await (const record of parser as AsyncIterable<Record<string, string>>) {
    const index = rowIndex++;

    if (limit !== undefined && index >= limit) {
      // Hard structural cap: stop reading the CSV entirely. Rows beyond
      // --limit are never even looked at in a non-dry-run.
      break;
    }

    if (sentIndices.has(index) || failedIndices.has(index)) {
      skippedCount++;
      continue;
    }

    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
    }

    const recipient: Recipient = { index, email: record.email!, name: record.name! };
    const task: Promise<void> = processRow(recipient).then(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
  }

  await Promise.all(inFlight);

  clearInterval(progressTimer);
  printProgress(true);

  sentLog.end();
  failedLog.end();

  const limitSuffix = limit !== undefined ? ` limit=${limit}` : "";
  console.log(
    `Done. sent=${sentCount} failed=${failedCount} skipped=${skippedCount} total_rows_in_file=${totalRows}${limitSuffix} already_done_before_this_run=${alreadyDone}`,
  );
}
