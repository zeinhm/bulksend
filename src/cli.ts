import { generate } from "./generate.js";
import { send } from "./send.js";
import { mockProvider, smtpProvider } from "./provider.js";

const SMTP_LIMIT_CEILING = 1000;

function parsePositiveInt(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Invalid --${flagName}: "${raw}" (must be a positive integer)`);
    process.exit(1);
  }
  return value;
}

function assertKnownFlags(flags: Record<string, string>, allowed: readonly string[], command: string): void {
  const unknown = Object.keys(flags).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    console.error(
      `Unknown flag(s) for '${command}': ${unknown.map((f) => `--${f}`).join(", ")}\nAllowed: ${allowed.map((f) => `--${f}`).join(", ")}`,
    );
    process.exit(1);
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = "true";
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);

  switch (command) {
    case "generate": {
      assertKnownFlags(flags, ["count", "out"], "generate");
      const count = flags.count !== undefined ? parsePositiveInt(flags.count, "count") : 1_000_000;
      const out = flags.out ?? "recipients.csv";
      console.log(`Generating ${count.toLocaleString()} rows to ${out}...`);
      const start = performance.now();
      await generate(count, out);
      const seconds = (performance.now() - start) / 1000;
      console.log(`Done in ${seconds.toFixed(1)}s.`);
      break;
    }
    case "send": {
      assertKnownFlags(flags, ["csv", "concurrency", "rate", "smtp", "limit"], "send");
      const csvPath = flags.csv ?? "recipients.csv";
      const concurrency = flags.concurrency !== undefined ? parsePositiveInt(flags.concurrency, "concurrency") : 50;
      const rate = flags.rate !== undefined ? parsePositiveInt(flags.rate, "rate") : 14;

      let limit: number | undefined;
      const useSmtp = flags.smtp !== undefined;

      if (useSmtp) {
        if (flags.limit === undefined) {
          console.error(
            "--smtp requires an explicit --limit N (refusing to run against the full recipient list).",
          );
          process.exit(1);
        }
        limit = parsePositiveInt(flags.limit, "limit");
        if (limit > SMTP_LIMIT_CEILING) {
          console.error(`--limit ${limit} exceeds the safety ceiling of ${SMTP_LIMIT_CEILING} for --smtp mode.`);
          process.exit(1);
        }
      }

      // Separate log files per transport: a mock dry-run "sent" and a real
      // SMTP "sent" must never be treated as interchangeable on resume --
      // otherwise a prior dry-run silently makes --smtp skip rows it has
      // never actually sent for real.
      const sentLogPath = useSmtp ? "sent.smtp.ndjson" : "sent.ndjson";
      const failedLogPath = useSmtp ? "failed.smtp.ndjson" : "failed.ndjson";

      await send({
        csvPath,
        sentLogPath,
        failedLogPath,
        concurrency,
        ratePerSecond: rate,
        dryRun: !useSmtp,
        provider: useSmtp ? smtpProvider : mockProvider,
        limit,
      });
      break;
    }
    default:
      console.error(
        `Unknown command: ${command ?? "(none)"}\nUsage:\n  cli generate [--count N] [--out path]\n  cli send [--csv path] [--concurrency N] [--rate N] [--smtp --limit N]`,
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
