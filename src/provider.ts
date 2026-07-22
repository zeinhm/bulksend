import nodemailer from "nodemailer";

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

const FROM_ADDRESS = "campaign@example.test";

// Mailpit's default SMTP listener: no auth, no TLS.
const transporter = nodemailer.createTransport({
  host: "localhost",
  port: 1025,
  secure: false,
});

export const smtpProvider: Provider = {
  async send(recipient: Recipient, subject: string, body: string): Promise<SendResult> {
    try {
      await transporter.sendMail({ from: FROM_ADDRESS, to: recipient.email, subject, text: body });
      return { status: "sent" };
    } catch (err) {
      const responseCode = (err as { responseCode?: unknown }).responseCode;
      // SMTP 4xx is a temporary failure (retry); 5xx and everything else is
      // treated as permanent, matching the mock provider's split.
      if (typeof responseCode === "number" && responseCode >= 400 && responseCode < 500) {
        return { status: "rate_limited", retryAfterMs: 300 };
      }
      return { status: "permanent_failure", reason: err instanceof Error ? err.message : String(err) };
    }
  },
};
