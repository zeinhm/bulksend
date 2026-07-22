import { createReadStream } from "node:fs";
import { parse } from "csv-parse";
import { mockProvider, type Recipient, type SendResult } from "./provider.js";
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
}

const MAX_ATTEMPTS = 3;

async function sendWithRetry(
  recipient: Recipient,
  subject: string,
  body: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result: SendResult = await mockProvider.send(recipient, subject, body);
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
  const { csvPath, sentLogPath, failedLogPath, concurrency, ratePerSecond, dryRun } = options;

  if (!dryRun) {
    throw new Error("Only --dry-run is supported right now; SMTP sending is not implemented yet.");
  }

  const renderSubject = compileTemplate(SUBJECT_TEMPLATE);
  const renderBody = compileTemplate(BODY_TEMPLATE);

  const sentIndices = loadCompletedIndices(sentLogPath);
  const failedIndices = loadCompletedIndices(failedLogPath);
  const alreadyDone = sentIndices.size + failedIndices.size;

  const totalRows = await countDataRows(csvPath);

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
    const remaining = Math.max(totalRows - alreadyDone - processed, 0);
    const line = `sent=${sentCount} failed=${failedCount} skipped=${skippedCount} remaining=${remaining} (${rate.toFixed(1)}/s)`;
    process.stdout.write(final ? `${line}\n` : `\r${line}   `);
  }

  const progressTimer = setInterval(printProgress, 500);

  async function processRow(recipient: Recipient): Promise<void> {
    await acquireRateSlot();

    const subject = renderSubject(recipient.name);
    const body = renderBody(recipient.name);
    const outcome = await sendWithRetry(recipient, subject, body);

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

  console.log(
    `Done. sent=${sentCount} failed=${failedCount} skipped=${skippedCount} total_rows=${totalRows} already_done_before_this_run=${alreadyDone}`,
  );
}
