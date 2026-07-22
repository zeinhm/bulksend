export interface Recipient {
  index: number;
  email: string;
  name: string;
}

export type SendResult =
  | { status: "sent" }
  | { status: "rate_limited"; retryAfterMs: number }
  | { status: "permanent_failure"; reason: string };

export interface Provider {
  send(recipient: Recipient, subject: string, body: string): Promise<SendResult>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 20-80ms simulated latency, ~0.2% permanent (550) failures, ~1% transient
// (429 + Retry-After) failures, remainder sent.
export const mockProvider: Provider = {
  async send(recipient: Recipient): Promise<SendResult> {
    const latencyMs = 20 + Math.random() * 60;
    await sleep(latencyMs);

    const roll = Math.random();
    if (roll < 0.002) {
      return {
        status: "permanent_failure",
        reason: `550 mailbox unavailable for ${recipient.email} (simulated)`,
      };
    }
    if (roll < 0.012) {
      return { status: "rate_limited", retryAfterMs: 200 + Math.random() * 300 };
    }
    return { status: "sent" };
  },
};
