import { generate } from "./generate.js";

function parsePositiveInt(raw: string, flagName: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    console.error(`Invalid --${flagName}: "${raw}" (must be a positive integer)`);
    process.exit(1);
  }
  return value;
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
      const count = flags.count !== undefined ? parsePositiveInt(flags.count, "count") : 1_000_000;
      const out = flags.out ?? "recipients.csv";
      console.log(`Generating ${count.toLocaleString()} rows to ${out}...`);
      const start = performance.now();
      await generate(count, out);
      const seconds = (performance.now() - start) / 1000;
      console.log(`Done in ${seconds.toFixed(1)}s.`);
      break;
    }
    default:
      console.error(`Unknown command: ${command ?? "(none)"}\nUsage: cli generate [--count N] [--out path]`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
