Hard parts: 1M rows = must stream, not load.
Speed = bounded concurrency, not infinite parallel.
Crash = must resume without double-sending.
Proof = Mailpit for correctness, mock+latency for throughput.
Keep it one script, small.
Decisions: TS/Node, csv streaming, p-limit ~50, NDJSON sent-log, dry-run default.
Not building: bounces, unsubscribe, warm-up, queues.
Done when:
1. `generate` produces 1M rows to recipients.csv with flat memory (streamed)
2. `send --dry-run` completes all 1M with progress + emails/sec stats
3. Running send twice = zero duplicate sends (proven by test)
4. Kill mid-run, restart = resumes where it died, no duplicates (proven by test)
5. ~100 emails visible in Mailpit, names personalized correctly (screenshot)
6. README lists every assumption + the real measured throughput number