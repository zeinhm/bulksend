# Plan: bulk campaign send (1M recipients)

## Problem
Send one promotional email, personalized by name, to 1,000,000 recipients, as fast
as reasonably possible, without hitting real inboxes. Single TS/Node CLI script,
~300 lines, no queues/Redis/workers.

## Decisions

- **Streaming CSV in, streaming log out.** Never hold the recipient list in memory.
  Use a real CSV parser (not `split(',')`) so quoted fields (e.g. names with commas)
  don't corrupt personalization.
- **Resume tracked by row index, not email string.** Sent-log is an append-only file
  of row numbers. On startup, rebuild a `Set<number>` from it — O(n) in row count,
  not in email-string bytes, and consistent with "never hold the full list in memory."
- **Two separate limits, not one.** Concurrency limit (p-limit ~50, bounds our own
  memory/fd usage) is a different knob from a rate limit (requests/sec cap, respects
  the provider's actual constraint). A per-second window counter is enough — no
  token-bucket library.
- **Mock simulates provider throttling.** Random/injected 429 + `Retry-After` and
  550 responses, so the backoff path and dead-letter path are actually exercised,
  not just theoretical.
- **Three outcomes per recipient, not two.** `sent.ndjson` (row index, on provider
  ack), `failed.ndjson` (each entry tagged `kind: "permanent" | "exhausted"` — a
  550-class response is permanent and skipped forever; a row that only exhausted
  its 3 in-run retries on transient 429s is not known-bad, so it's not skipped on
  the next `send` run and gets reprocessed), and implicit "pending" (absence from
  both, or an "exhausted" entry). Transient failures retry with backoff within a
  run before ever reaching that exhausted state.
- **At-least-once, not exactly-once — stated, not hidden.** A kill between "provider
  accepted" and "log write flushed" can double-send. We accept and document this
  rather than claim a guarantee the design can't back up.
- **Crash test uses SIGKILL**, not SIGINT. Graceful shutdown proves nothing about
  durability; a hard kill mid-batch is the real test of the resume path.
- **Sent-log writes: per-line append unless it visibly complicates the code.** Buffer
  only if it stays simple; otherwise per-line `fs.appendFile` at this scale is an
  acceptable, honest tradeoff — not a bottleneck worth added complexity.
- **Two throughput numbers, reported separately in the README:**
  1. Measured mock throughput (what the pipeline itself can push, event-loop bound).
  2. Real-world estimate = `1,000,000 / provider_rate_limit`, independent of code.
  The mock number is a claim about the pipeline, not about a real ESP.
- **Default rate limit: 14 req/s**, based on AWS SES's default new-account sending
  rate (SES assigns 14 emails/second to new production accounts before any quota
  increase request). Configurable via `--rate`, so a reviewer can see the effect of
  changing it without touching code.
- **`--dry-run` is the default mode.** The script never calls `--smtp` unless the
  flag is explicitly passed. Running with no flags is always safe.
- **`--smtp` requires an explicit `--limit N`.** The script refuses to run in SMTP
  mode against the full recipient list — no `--limit` (or a limit above a small
  sane ceiling) with `--smtp` is a hard error, not a warning. This makes "accidentally
  emailing 1M real addresses" structurally impossible, not just discouraged.

## Structure

- `src/cli.ts` — entry point; parses flags, wires `generate`/`send` commands.
- `src/generate.ts` — streams `recipients.csv` (N rows) to disk.
- `src/send.ts` — reads CSV, drives the send loop, applies limits, writes logs.
- `src/provider.ts` — `send(recipient)` interface; mock (simulated latency,
  429/550 injection) and smtp (Mailpit) implementations behind it.
- `src/limits.ts` — concurrency cap (p-limit) + rate limiter (per-second window).
- `src/logs.ts` — `sent.ndjson` / `failed.ndjson` read (resume) and append.

## Rejected alternatives

- Token-bucket/leaky-bucket rate limiter library — a per-second counter is enough
  for one process; a library would be scope creep against the 300-line budget.
- Worker threads — the work is I/O-bound (network calls + trivial string
  interpolation), so Node's single-threaded event loop is not the bottleneck.
  No CPU-bound work here justifies the complexity.
- Queues/Redis/external workers — explicitly out of scope for a single-process
  assessment; would be the right call at real multi-machine scale, not here.
- Full exactly-once delivery (idempotency keys, transactional log+send) — real
  ESPs (SES, Postmark) support client-supplied idempotency keys for this; out of
  scope for a mock provider. Documented as a known gap, not solved.

## Assumptions

- `recipients.csv` is stable and not reordered between runs (row-index resume
  depends on this).
- "As fast as possible" is bounded by the provider's rate limit, not by our own
  concurrency — going above the provider's real cap just produces more 429s, not
  more throughput.
- Bounce handling, unsubscribe, IP/domain warm-up are out of scope (unchanged from
  original framing).

## Out of scope

Bounce handling, unsubscribe management, sender warm-up, queues/Redis/external
workers, token-bucket rate limiting, exactly-once delivery guarantees, multi-process
scaling.

## Scope guard

Everything above must fit in one process, ~300 lines. If any piece (rate limiter,
CSV parsing, retry/backoff) needs a library or abstraction that meaningfully grows
the script, flag it before implementing and cut scope rather than grow silently.

## Done when

1. `generate` produces 1M rows to `recipients.csv` with flat memory (streamed).
2. `send --dry-run` completes all 1M with progress + emails/sec stats.
3. Running `send` twice = zero duplicate sends (proven by test).
4. `kill -9` mid-run, restart = resumes where it died, no duplicates (proven by test).
5. Permanently-failing addresses land in `failed.ndjson` with `kind: "permanent"`
   and are not retried on resume; addresses that only exhausted in-run retries
   land with `kind: "exhausted"` and DO get retried on the next resume, rather
   than being treated as dead forever (proven by test).
6. ~100 emails visible in Mailpit, names personalized correctly (screenshot).
7. README lists every assumption, the at-least-once tradeoff, and both throughput
   numbers (measured mock vs. real-provider estimate).
