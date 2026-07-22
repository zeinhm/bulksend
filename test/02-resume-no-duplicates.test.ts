// Integration test: generate 1000 rows, run `send` to completion, run it
// again unchanged, and assert:
//   - combined sent.ndjson + failed.ndjson index set has exactly 1000
//     unique entries covering 0..999
//   - zero duplicate index lines across either file
//   - the second run's own reported sent+failed counts are 0 (everything
//     skipped as already-done)
//
// Must run in its own scratch directory because cli.ts hardcodes
// sent.ndjson/failed.ndjson as cwd-relative paths.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = "/Users/zein/projects/bulksend/src/cli.ts";
const ROWS = 1000;

const scratch = mkdtempSync(path.join(tmpdir(), "bulksend-test-dedup-"));
console.log("scratch dir:", scratch);

function run(args: string[]): string {
  return execFileSync("npx", ["tsx", CLI, ...args], {
    cwd: scratch,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

try {
  run(["generate", "--count", String(ROWS), "--out", "recipients.csv"]);

  const run1Out = run(["send", "--csv", "recipients.csv", "--rate", "500", "--concurrency", "50"]);
  console.log("--- run 1 output (tail) ---");
  console.log(run1Out.trim().split("\n").slice(-3).join("\n"));

  const run1Done = run1Out.trim().split("\n").filter((l) => l.startsWith("Done.")).pop();
  assert.ok(run1Done, "run 1 should print a Done. summary line");
  const run1Match = run1Done!.match(/sent=(\d+) failed=(\d+) skipped=(\d+)/);
  assert.ok(run1Match, "run 1 Done. line should match expected format");
  const run1Sent = Number(run1Match![1]);
  const run1Failed = Number(run1Match![2]);
  const run1Skipped = Number(run1Match![3]);
  console.log(`run1: sent=${run1Sent} failed=${run1Failed} skipped=${run1Skipped}`);
  assert.equal(run1Sent + run1Failed + run1Skipped, ROWS, "run 1 should account for every row");
  assert.equal(run1Skipped, 0, "run 1 (fresh run) should skip nothing");

  const run2Out = run(["send", "--csv", "recipients.csv", "--rate", "500", "--concurrency", "50"]);
  console.log("--- run 2 output (tail) ---");
  console.log(run2Out.trim().split("\n").slice(-3).join("\n"));

  const run2Done = run2Out.trim().split("\n").filter((l) => l.startsWith("Done.")).pop();
  assert.ok(run2Done, "run 2 should print a Done. summary line");
  const run2Match = run2Done!.match(/sent=(\d+) failed=(\d+) skipped=(\d+)/);
  assert.ok(run2Match, "run 2 Done. line should match expected format");
  const run2Sent = Number(run2Match![1]);
  const run2Failed = Number(run2Match![2]);
  const run2Skipped = Number(run2Match![3]);
  console.log(`run2: sent=${run2Sent} failed=${run2Failed} skipped=${run2Skipped}`);

  assert.equal(run2Sent, 0, "second run should send 0 new rows (all already done)");
  assert.equal(run2Failed, 0, "second run should fail 0 new rows (all already done)");
  assert.equal(run2Skipped, ROWS, "second run should skip all 1000 rows as already-done");

  // Now inspect the actual log files on disk.
  function readIndices(file: string): number[] {
    const p = path.join(scratch, file);
    let text: string;
    try {
      text = readFileSync(p, "utf8");
    } catch {
      return [];
    }
    const lines = text.split("\n").filter((l) => l.length > 0);
    return lines.map((l) => (JSON.parse(l) as { index: number }).index);
  }

  const sentIndices = readIndices("sent.ndjson");
  const failedIndices = readIndices("failed.ndjson");
  console.log(`sent.ndjson lines=${sentIndices.length} failed.ndjson lines=${failedIndices.length}`);

  const allIndices = [...sentIndices, ...failedIndices];
  assert.equal(allIndices.length, ROWS, `combined line count should be exactly ${ROWS}, got ${allIndices.length}`);

  const uniqueIndices = new Set(allIndices);
  assert.equal(uniqueIndices.size, ROWS, `combined unique index count should be exactly ${ROWS}, got ${uniqueIndices.size}`);
  assert.equal(uniqueIndices.size, allIndices.length, "there must be zero duplicate index lines across sent+failed combined");

  for (let i = 0; i < ROWS; i++) {
    assert.ok(uniqueIndices.has(i), `index ${i} missing from combined sent+failed set`);
  }

  console.log("PASS: 02-resume-no-duplicates.test.ts");
} finally {
  rmSync(scratch, { recursive: true, force: true });
  console.log("cleaned up", scratch);
}
