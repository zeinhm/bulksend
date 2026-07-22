// Integration test: SIGKILL send mid-run, rerun, and assert exactly-once
// accounting: union of sent.ndjson + failed.ndjson indices has no
// duplicates and covers every row index exactly once (0..N-1).
//
// Per task guidance: `npx tsx cli.ts send ...` can spawn more than one OS
// process (the npx wrapper + the actual node/tsx process), so a plain
// `kill -9 <pid>` on the top-level spawned pid may leave a child running.
// We instead use `pkill -9 -f "<marker>"` against a unique --csv path to
// kill every matching process in one shot, then confirm with `pgrep -f`
// that nothing remains before inspecting file state.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = "/Users/zein/projects/bulksend/src/cli.ts";
const ROWS = 4000; // large enough that a slow rate guarantees a partial run

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readIndices(file: string): number[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => (JSON.parse(l) as { index: number }).index);
}

async function main(): Promise<void> {
  const scratch = mkdtempSync(path.join(tmpdir(), "bulksend-test-crash-"));
  console.log("scratch dir:", scratch);
  const csvPath = path.join(scratch, "recipients.csv"); // unique absolute path = our pkill marker
  const sentPath = path.join(scratch, "sent.ndjson");
  const failedPath = path.join(scratch, "failed.ndjson");

  try {
    execFileSync("npx", ["tsx", CLI, "generate", "--count", String(ROWS), "--out", "recipients.csv"], {
      cwd: scratch,
      stdio: "ignore",
    });

    const pkillMarker = `cli.ts send --csv ${csvPath}`;

    // Slow rate so a partial run is guaranteed within our sleep window.
    const child = spawn(
      "npx",
      ["tsx", CLI, "send", "--csv", csvPath, "--rate", "30", "--concurrency", "10"],
      { cwd: scratch, stdio: "ignore", detached: true },
    );
    console.log("spawned pid:", child.pid);

    await sleep(1500);

    // Confirm partial progress before killing (best-effort; not required to pass).
    const preKillCount = readIndices(sentPath).length + readIndices(failedPath).length;
    console.log("pre-kill combined line count:", preKillCount);

    execFileSync("pkill", ["-9", "-f", pkillMarker], { stdio: "ignore" });
    // give the OS a brief moment to actually reap the process
    await sleep(300);

    let stillRunning = "";
    try {
      stillRunning = execFileSync("pgrep", ["-f", pkillMarker], { encoding: "utf8" });
    } catch {
      // pgrep exits non-zero when nothing matches -- that's the good case.
      stillRunning = "";
    }
    assert.equal(stillRunning.trim(), "", `expected no processes left matching marker, found:\n${stillRunning}`);
    console.log("confirmed: no processes left matching marker");

    const afterKillSent = readIndices(sentPath);
    const afterKillFailed = readIndices(failedPath);
    const afterKillCount = afterKillSent.length + afterKillFailed.length;
    console.log("post-kill combined line count:", afterKillCount, "/", ROWS);

    assert.ok(afterKillCount > 0, "expected some progress to have been made before the kill");
    assert.ok(
      afterKillCount < ROWS,
      `expected a genuinely partial run (< ${ROWS}), got ${afterKillCount} -- timing didn't produce a partial run, rerun with a slower rate or bigger file`,
    );

    // Sanity: no duplicates even in the partial state.
    const afterKillAll = [...afterKillSent, ...afterKillFailed];
    assert.equal(new Set(afterKillAll).size, afterKillAll.length, "no duplicate indices should exist even in the partial (post-kill) state");

    // Rerun to completion.
    const rerunOut = execFileSync(
      "npx",
      ["tsx", CLI, "send", "--csv", csvPath, "--rate", "500", "--concurrency", "50"],
      { cwd: scratch, encoding: "utf8" },
    );
    console.log("--- rerun output (tail) ---");
    console.log(rerunOut.trim().split("\n").slice(-3).join("\n"));

    const finalSent = readIndices(sentPath);
    const finalFailed = readIndices(failedPath);
    const finalAll = [...finalSent, ...finalFailed];
    console.log(`final: sent.ndjson lines=${finalSent.length} failed.ndjson lines=${finalFailed.length} combined=${finalAll.length}`);

    const finalUnique = new Set(finalAll);
    assert.equal(finalUnique.size, finalAll.length, "final combined set must have zero duplicate index lines");
    assert.equal(finalUnique.size, ROWS, `final combined unique index count should be exactly ${ROWS}, got ${finalUnique.size}`);
    for (let i = 0; i < ROWS; i++) {
      assert.ok(finalUnique.has(i), `index ${i} missing from final combined set`);
    }

    console.log("PASS: 03-crash-resume.test.ts");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    console.log("cleaned up", scratch);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
