// Integration test: finding #1 fix -- failed.ndjson entries carry a
// `kind: "permanent" | "exhausted"` field, and only "permanent" entries
// count as done-forever on resume. "exhausted" entries (all retries hit
// transient/429 within a single run) must NOT be skipped on the next run;
// they're eligible to be reprocessed since the row was never actually
// confirmed bad.
//
// Forcing the real mock provider to exhaust all 3 attempts is astronomically
// rare (~1e-6/row: three independent ~1% transient rolls), so instead we
// hand-craft failed.ndjson directly (same technique as test 04) with one
// synthetic "exhausted" line and one synthetic "permanent" line for two rows
// that have never been sent, then run `send` and assert:
//   - the "permanent" row is skipped (counted in skippedCount, no new log
//     entry for it, never touched by the provider)
//   - the "exhausted" row is NOT skipped -- it gets reprocessed and ends up
//     with a fresh outcome (either a new sent.ndjson line, or a second
//     failed.ndjson line for the same index)

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = "/Users/zein/projects/bulksend/src/cli.ts";
const ROWS = 30;
const EXHAUSTED_INDEX = 3;
const PERMANENT_INDEX = 5;

function readLines(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter((l) => l.length > 0);
}

function parsed(lines: string[]): Array<{ index: number; kind?: string }> {
  return lines.map((l) => JSON.parse(l) as { index: number; kind?: string });
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "bulksend-test-exhausted-"));
  console.log("scratch dir:", scratch);
  try {
    execFileSync("npx", ["tsx", CLI, "generate", "--count", String(ROWS), "--out", "recipients.csv"], {
      cwd: scratch,
      stdio: "ignore",
    });

    const failedPath = path.join(scratch, "failed.ndjson");
    const sentPath = path.join(scratch, "sent.ndjson");

    // Hand-craft failed.ndjson with two synthetic entries for rows that have
    // never actually been sent or attempted. Neither index appears in
    // sent.ndjson (which doesn't exist yet).
    const craftedLines = [
      JSON.stringify({
        index: EXHAUSTED_INDEX,
        email: `row${EXHAUSTED_INDEX}@example.test`,
        kind: "exhausted",
        reason: "429 rate-limited, retries exhausted after 3 attempts (synthetic, from prior run)",
      }),
      JSON.stringify({
        index: PERMANENT_INDEX,
        email: `row${PERMANENT_INDEX}@example.test`,
        kind: "permanent",
        reason: "550 mailbox unavailable (synthetic, from prior run)",
      }),
    ];
    writeFileSync(failedPath, craftedLines.map((l) => l + "\n").join(""), "utf8");
    console.log("crafted failed.ndjson:", craftedLines);

    const out = execFileSync(
      "npx",
      ["tsx", CLI, "send", "--csv", "recipients.csv", "--rate", "500", "--concurrency", "50"],
      { cwd: scratch, encoding: "utf8" },
    );
    console.log("--- send output (tail) ---");
    console.log(out.trim().split("\n").slice(-3).join("\n"));

    const doneLine = out.trim().split("\n").filter((l) => l.startsWith("Done.")).pop();
    assert.ok(doneLine, "should print a Done. summary line");
    const match = doneLine!.match(/sent=(\d+) failed=(\d+) skipped=(\d+)/);
    assert.ok(match, "Done. line should match expected format");
    const sentCount = Number(match![1]);
    const failedCount = Number(match![2]);
    const skippedCount = Number(match![3]);
    console.log(`sent=${sentCount} failed=${failedCount} skipped=${skippedCount}`);

    // Exactly one row (the "permanent" one) should be skipped on resume.
    // The "exhausted" row must be among the ROWS-1 rows actually processed
    // this run (sent+failed), not among the skipped ones.
    assert.equal(skippedCount, 1, "only the 'permanent' row should be skipped -- the 'exhausted' row must be reprocessed");
    assert.equal(sentCount + failedCount, ROWS - 1, "every row except the skipped 'permanent' one should have been attempted this run");

    const finalSentLines = readLines(sentPath);
    const finalFailedLines = readLines(failedPath);
    const finalSent = parsed(finalSentLines);
    const finalFailed = parsed(finalFailedLines);

    // --- permanent row: must NOT have been touched at all ---
    const permanentInSent = finalSent.filter((e) => e.index === PERMANENT_INDEX);
    const permanentInFailed = finalFailed.filter((e) => e.index === PERMANENT_INDEX);
    assert.equal(permanentInSent.length, 0, "'permanent' row must never appear in sent.ndjson");
    assert.equal(
      permanentInFailed.length,
      1,
      "'permanent' row must still have exactly its one original failed.ndjson line -- no reprocessing, no new entry",
    );
    assert.equal(permanentInFailed[0]!.kind, "permanent", "the surviving entry for the permanent row must still be kind=permanent");

    // --- exhausted row: must have been reprocessed, i.e. a NEW outcome exists ---
    const exhaustedInSent = finalSent.filter((e) => e.index === EXHAUSTED_INDEX);
    const exhaustedInFailed = finalFailed.filter((e) => e.index === EXHAUSTED_INDEX);
    console.log(
      `exhausted row (index ${EXHAUSTED_INDEX}): sent.ndjson entries=${exhaustedInSent.length}, failed.ndjson entries=${exhaustedInFailed.length}`,
    );

    // It was reprocessed iff either (a) it now has a sent.ndjson entry it
    // never had before, or (b) failed.ndjson now has a SECOND line for this
    // index (the original synthetic "exhausted" line plus a fresh outcome
    // from this run).
    const wasReprocessed = exhaustedInSent.length >= 1 || exhaustedInFailed.length >= 2;
    assert.ok(
      wasReprocessed,
      `'exhausted' row (index ${EXHAUSTED_INDEX}) should have been reprocessed: expected either a sent.ndjson entry or a second failed.ndjson entry, got sent=${exhaustedInSent.length} failed=${exhaustedInFailed.length}`,
    );

    // It must not appear in BOTH sent.ndjson and failed.ndjson as a fresh
    // entry for the same run (that would be a double-send/duplicate-outcome
    // bug, separate from what this test targets, but worth a cheap check).
    if (exhaustedInSent.length >= 1) {
      assert.equal(exhaustedInFailed.length, 1, "if the exhausted row ended up sent this run, failed.ndjson should still only have its original synthetic line, not an additional one");
    }

    // Sanity: overall accounting still holds -- every index 0..ROWS-1
    // accounted for exactly once across "reached a durable terminal state"
    // (permanent failures and sends), with the exhausted row's *latest*
    // outcome counted, not double-counted.
    const sentIdxSet = new Set(finalSent.map((e) => e.index));
    // failed.ndjson may have 2 lines for EXHAUSTED_INDEX (append-only log);
    // dedupe by index for this sanity check, matching what a real "current
    // known-bad" reader (kind=permanent only) would see.
    const permanentFailedIdxSet = new Set(finalFailed.filter((e) => e.kind === "permanent").map((e) => e.index));
    const coveredByDurableState = new Set([...sentIdxSet, ...permanentFailedIdxSet]);
    // Every index should be covered UNLESS it's the exhausted row and it
    // exhausted again (vanishingly unlikely, but if it happened, it simply
    // wouldn't appear in either durable set -- that's still correct
    // behavior, just not what we assert precisely here).
    const missing = [...Array(ROWS).keys()].filter((i) => !coveredByDurableState.has(i));
    if (missing.length > 0) {
      assert.deepEqual(
        missing,
        [EXHAUSTED_INDEX],
        `unexpected rows missing from durable sent/permanent-failed state: ${JSON.stringify(missing)}`,
      );
      console.log(
        `note: index ${EXHAUSTED_INDEX} exhausted again this run (probability ~1e-6) -- still correctly not marked done, would retry on a third run`,
      );
    }

    console.log("PASS: 05-exhausted-vs-permanent-retry.test.ts");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    console.log("cleaned up", scratch);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
