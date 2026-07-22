// Integration test: log-file torn-line / corruption handling.
//
// (a) Torn last line (no trailing newline, simulating a kill mid-write()):
//     next `send` run should print the self-heal warning from
//     src/logs.ts::loadCompletedIndices, exit 0, re-send the affected row,
//     and leave the file with only valid-JSON lines.
//
// (b) Corrupted line in the MIDDLE of the file (not the last line, so not a
//     torn write but real corruption): next `send` run should exit non-zero
//     and must NOT silently continue.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const CLI = "/Users/zein/projects/bulksend/src/cli.ts";
const ROWS = 50;

function readLines(file: string): string[] {
  return readFileSync(file, "utf8").split("\n").filter((l) => l.length > 0);
}

function indexOf(line: string): number {
  return (JSON.parse(line) as { index: number }).index;
}

function runCli(cwd: string, args: string[]): { code: number; stdout: string; stderr: string } {
  // execFileSync only returns stdout, and only on a zero exit code -- it
  // discards stderr entirely on success. We need stderr on BOTH success and
  // failure (the torn-line warning is printed via console.warn on the
  // success path), so use spawnSync instead, which always captures both.
  const result = spawnSync("npx", ["tsx", CLI, ...args], { cwd, encoding: "utf8" });
  return { code: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function partA(): Promise<void> {
  console.log("\n=== Part (a): torn last line ===");
  const scratch = mkdtempSync(path.join(tmpdir(), "bulksend-test-torn-"));
  console.log("scratch dir:", scratch);
  try {
    execFileSync("npx", ["tsx", CLI, "generate", "--count", String(ROWS), "--out", "recipients.csv"], {
      cwd: scratch,
      stdio: "ignore",
    });

    const r1 = runCli(scratch, ["send", "--csv", "recipients.csv", "--rate", "500", "--concurrency", "50"]);
    assert.equal(r1.code, 0, `initial send should succeed, stderr: ${r1.stderr}`);

    const sentPath = path.join(scratch, "sent.ndjson");
    const lines = readLines(sentPath);
    assert.ok(lines.length > 0, "sent.ndjson should have at least one line to tear");

    const lastLine = lines[lines.length - 1]!;
    const tornIndex = indexOf(lastLine);
    console.log("original last sent.ndjson line:", lastLine, "-> index", tornIndex);

    // Chop bytes off the end of the last line (drop trailing newline AND
    // part of the line's content), simulating a kill mid-write().
    const keepChars = Math.max(1, Math.floor(lastLine.length / 2));
    const tornLastLine = lastLine.slice(0, keepChars);
    const newContent = lines.slice(0, -1).map((l) => l + "\n").join("") + tornLastLine; // no trailing \n
    writeFileSync(sentPath, newContent, "utf8");
    console.log("truncated sent.ndjson last line to:", JSON.stringify(tornLastLine), "(no trailing newline)");

    const r2 = runCli(scratch, ["send", "--csv", "recipients.csv", "--rate", "500", "--concurrency", "50"]);
    console.log("--- rerun stdout+stderr (a) ---");
    console.log((r2.stdout + r2.stderr).trim().split("\n").slice(0, 5).join("\n"));

    assert.equal(r2.code, 0, `rerun after torn line should exit 0, got ${r2.code}. stderr: ${r2.stderr}`);

    const combinedOutput = r2.stdout + r2.stderr;
    const warningRe = /byte\(s\) after the last complete line/i;
    assert.ok(
      warningRe.test(combinedOutput),
      `expected the self-heal warning about torn bytes in output, got stdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`,
    );
    console.log("confirmed warning text present");

    // Every line in the resulting sent.ndjson must parse as valid JSON.
    const finalSentLines = readLines(sentPath);
    for (const [i, line] of finalSentLines.entries()) {
      assert.doesNotThrow(() => JSON.parse(line), `line ${i + 1} of sent.ndjson should be valid JSON, got: ${line}`);
    }
    console.log(`all ${finalSentLines.length} lines of sent.ndjson parse as valid JSON`);

    // The torn row must have been re-sent (appears in sent or failed).
    const finalFailedLines = readLines(path.join(scratch, "failed.ndjson"));
    const allIndices = new Set([
      ...finalSentLines.map(indexOf),
      ...finalFailedLines.map(indexOf),
    ]);
    assert.ok(allIndices.has(tornIndex), `torn row index ${tornIndex} should be re-sent (present in sent or failed) after rerun`);
    console.log(`confirmed torn row index ${tornIndex} was re-sent`);

    // Full accounting: every one of the ROWS indices should be present exactly once.
    assert.equal(allIndices.size, ROWS, `expected all ${ROWS} rows accounted for after self-heal + resend, got ${allIndices.size}`);

    console.log("PASS: part (a) torn last line");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    console.log("cleaned up", scratch);
  }
}

async function partB(): Promise<void> {
  console.log("\n=== Part (b): corrupted middle line ===");
  const scratch = mkdtempSync(path.join(tmpdir(), "bulksend-test-corrupt-"));
  console.log("scratch dir:", scratch);
  try {
    execFileSync("npx", ["tsx", CLI, "generate", "--count", String(ROWS), "--out", "recipients.csv"], {
      cwd: scratch,
      stdio: "ignore",
    });

    const r1 = runCli(scratch, ["send", "--csv", "recipients.csv", "--rate", "500", "--concurrency", "50"]);
    assert.equal(r1.code, 0, `initial send should succeed, stderr: ${r1.stderr}`);

    const sentPath = path.join(scratch, "sent.ndjson");
    const lines = readLines(sentPath);
    assert.ok(lines.length >= 3, `need at least 3 sent.ndjson lines to corrupt a middle one, got ${lines.length}`);

    const middleIdx = Math.floor(lines.length / 2);
    console.log(`corrupting line ${middleIdx + 1} of ${lines.length} (not the last line) with invalid JSON`);
    lines[middleIdx] = "{this is not valid json!!";
    writeFileSync(sentPath, lines.map((l) => l + "\n").join(""), "utf8");

    const r2 = runCli(scratch, ["send", "--csv", "recipients.csv", "--rate", "500", "--concurrency", "50"]);
    console.log("--- rerun stdout+stderr (b) ---");
    console.log((r2.stdout + r2.stderr).trim().split("\n").slice(0, 5).join("\n"));
    console.log("exit code:", r2.code);

    assert.notEqual(r2.code, 0, "rerun with corrupted middle line must exit non-zero");

    const combinedOutput = r2.stdout + r2.stderr;
    assert.ok(
      /Corrupt line/i.test(combinedOutput),
      `expected a "Corrupt line" error in output, got stdout:\n${r2.stdout}\nstderr:\n${r2.stderr}`,
    );
    console.log("confirmed non-zero exit + corruption error text present");

    console.log("PASS: part (b) corrupted middle line");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    console.log("cleaned up", scratch);
  }
}

async function main(): Promise<void> {
  await partA();
  await partB();
  console.log("\nPASS: 04-torn-and-corrupt-lines.test.ts (both parts)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
