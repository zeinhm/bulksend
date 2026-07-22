# bulksend

## Known characteristics

- **Rate limiter is a fixed per-second window, not a token bucket or sliding
  window.** This is intentional -- a plain window counter is enough for a
  single-process assessment tool, and adding a token-bucket dependency would
  be scope creep for what it buys. The tradeoff: requests can burst to
  roughly 2x `--rate` for a moment at window boundaries (e.g. `--rate`
  requests land right at the end of one window, then `--rate` more land
  immediately at the start of the next). Acceptable against the mock
  provider and against Mailpit; worth knowing if `--rate` is meant to model
  a real provider's hard per-second cap rather than a rough ceiling.
