# bulksend

## What this is

A CLI that sends one personalized promotional email to up to a million
recipients. It's a hands-on exercise in the three things that actually make
"send 1M emails" hard: sustained throughput under a provider's rate limit,
idempotent delivery so a crash never means a duplicate send, and resuming
cleanly from wherever a run stopped. Dry-run against an in-process mock
provider is the default mode — it never contacts a real mail server or
emails a real inbox unless you explicitly opt into `--smtp` pointed at a
local Mailpit instance.

## Quick start

```bash
# 1. Start Mailpit (only needed for --smtp mode; dry-run doesn't need it)
docker run -d --name mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit

# 2. Install
npm install

# 3. Generate recipients (defaults to 1,000,000 rows -> recipients.csv)
npm run generate

# 4a. Send, dry-run (default: mock provider, concurrency 50, rate 14/s)
npm run send

# 4b. Send, dry-run with custom throughput knobs
npm run send -- --concurrency 100 --rate 5000

# 4c. Send for real, against Mailpit only (requires --limit, capped at 1000)
npm run send -- --smtp --limit 100

# 5. Run the test suite
npm test
```

Mailpit's web UI (received mail) is at `http://localhost:8025`.

## Architecture

```
src/cli.ts        entry point — flag parsing, wires generate/send commands
src/generate.ts   streams recipients.csv (email,name) to disk, flat memory
src/send.ts       reads the CSV, drives the send loop: template render,
                   bounded concurrency, rate limiting, retry, logging
src/provider.ts   Provider interface; mock (simulated latency + injected
                   failures) and smtp (nodemailer -> Mailpit) implementations
src/limits.ts     per-second rate limiter
src/logs.ts       sent.ndjson / failed.ndjson: resume-state load + append
test/             5 test files (unit + integration), run via `npm test`
```

## Measured results

One real run, not a projection: `npm run generate` (1,000,000 rows), then
`npm run send -- --concurrency 100 --rate 5000` against the mock provider.

- **997,914 sent + 2,086 failed = 1,000,000 exactly** — every row accounted
  for once, matching the mock's injected ~0.2% permanent / ~1% transient
  failure rates at this scale.
- **~1,845 emails/sec sustained**, ~9 minutes wall clock (1,000,000 ÷
  1,845/s ≈ 542s).
- **Theoretical ceiling at this concurrency**: with the mock's 20–80ms
  simulated latency (avg 50ms), 100 concurrent slots gives a ceiling of
  `100 / 0.05s = 2,000/s`. Measured throughput (1,845/s) is **~92% of that
  ceiling** — the pipeline itself isn't the bottleneck, the (simulated)
  provider's per-request latency is, which is the realistic constraint to
  design around.
- **Real-world framing**: at SES's default new-account rate of 14 req/s,
  1,000,000 emails takes `1,000,000 / 14 ≈ 71,400s ≈ 19.8 hours`,
  regardless of how fast this code runs. Past a certain point, throughput
  is a negotiation with the provider for a higher rate limit, not a
  property of the code.

## Delivery semantics

- **At-least-once, not exactly-once, and that's a stated tradeoff, not a
  hidden gap.** A hard kill between "provider accepted the send" and "the
  log write for it landed on disk" can double-send that one row. The
  design accepts this rather than claiming a guarantee it can't back up
  (see "what changes for production" below for the real fix).
- **Torn-write self-heal.** A kill mid-`write()` can leave a log file
  ending in a partial line with no trailing newline. Only newline-terminated
  lines count as durably recorded: on startup, any bytes after the last
  complete line are discarded from the resume state *and* truncated off the
  file on disk, so the log is clean before this run's first append and that
  row is simply treated as not-yet-processed. A malformed line anywhere
  else in the file — not the torn tail — is real corruption, not a torn
  write, and is a hard error.
- **Permanent vs. exhausted failures are tracked separately**, via a `kind`
  field on each `failed.ndjson` entry. `kind: "permanent"` (a 550-class
  response) is a durable verdict on the address and is skipped forever on
  resume. `kind: "exhausted"` means this run's 3 in-run retries all hit
  transient (429-class) responses — the address isn't known-bad, so it is
  *not* skipped on the next `send` run and gets a fresh set of attempts.
  The old exhausted entry stays in the append-only log; a row can
  legitimately appear once as `"exhausted"` and later once in `sent.ndjson`
  once it succeeds on a subsequent run.
- **Rate limiter is a fixed per-second window, not a token bucket or
  sliding window.** This is intentional — a plain window counter is enough
  for a single-process tool, and a token-bucket dependency would be scope
  creep for what it buys. The tradeoff: requests can burst to roughly 2x
  `--rate` for a moment at window boundaries (e.g. `--rate` requests land
  right at the end of one window, then `--rate` more land immediately at
  the start of the next). Acceptable against the mock provider and against
  Mailpit; worth knowing if `--rate` is meant to model a real provider's
  hard per-second cap rather than a rough ceiling.

## Assumptions

- `recipients.csv` is stable and not reordered between runs — resume is
  tracked by row index, not by email string, so a reordered file breaks
  the resume guarantee.
- No CSV field contains an embedded literal newline. The real send loop
  uses a proper CSV parser and would handle this correctly, but the
  progress line's "remaining" figure comes from a fast newline-counting
  pre-pass that assumes one row per line; `generate.ts` never emits an
  embedded newline, so this holds for CSVs produced by this tool.
- Mailpit is reachable at `localhost:1025` for `--smtp` mode, with no auth
  and no TLS (its defaults).

## Safety rails

- **Dry-run is the default.** No flag is required to be safe — the script
  never touches a real transport unless `--smtp` is passed explicitly.
- **`--smtp` requires an explicit `--limit N`**, capped at a ceiling of
  1000. Omitting `--limit`, or passing one above the ceiling, is a hard
  error, not a warning.
- **The limit is a structural read cap, not just a send cap.** The CSV
  read loop itself stops once `limit` rows have been read — rows beyond
  the limit are never even parsed in a non-dry-run, not merely skipped
  after being looked at.
- **All generated addresses use `@example.test`**, a domain reserved by
  RFC 2606 and guaranteed to never resolve, so even a bug that bypassed
  every other safeguard couldn't reach a real inbox.

## What changes for production

This tool is deliberately scoped to a single-process assessment. Getting
from here to a real campaign sender means:

- **A real ESP behind the `Provider` interface.** The mock and Mailpit
  providers already prove the interface works; swapping in SES/Postmark/etc.
  is a config change, not a rewrite.
- **Connection pooling for SMTP.** The current `nodemailer` transport opens
  connections per call with no pooling configured — fine against local
  Mailpit, not fine at real scale.
- **Provider-side idempotency keys for actual exactly-once delivery.** Real
  ESPs (SES, Postmark) accept a client-supplied message ID for
  deduplication on their end — the real fix for the at-least-once gap
  documented above, out of scope for a mock provider.
- **Bounce and complaint handling**, **unsubscribe management**, and
  **sender/IP warm-up** — all real deliverability concerns, all
  deliberately out of scope here.
- **Distributed workers past single-process scale.** Bounded concurrency
  in one process is the right answer up to a provider's rate limit; beyond
  that (multiple provider accounts, multiple sending IPs) needs
  coordination this tool doesn't attempt.
