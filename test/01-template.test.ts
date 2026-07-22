// Unit test: template personalization ({{name}} substitution).
//
// compileTemplate() in src/send.ts is a module-private function (not
// exported), so it cannot be imported directly. Per task instructions this
// test duplicates the exact logic verbatim from src/send.ts (lines ~7-20 at
// time of writing) rather than reimplementing it differently. If send.ts's
// template logic changes, this copy must be kept in sync -- that drift risk
// is the tradeoff for testing non-exported logic without modifying src/.

import assert from "node:assert/strict";

// --- verbatim copy from src/send.ts ---
const SUBJECT_TEMPLATE = "A quick note just for {{name}}";
const BODY_TEMPLATE = [
  "Hi {{name}},",
  "",
  "Thanks for being part of our community -- we've got something we think",
  "you'll like this week.",
  "",
  "-- The Team",
].join("\n");

function compileTemplate(template: string): (name: string) => string {
  const parts = template.split("{{name}}");
  return (name: string): string => parts.join(name);
}
// --- end verbatim copy ---

const renderSubject = compileTemplate(SUBJECT_TEMPLATE);
const renderBody = compileTemplate(BODY_TEMPLATE);

// Name deliberately contains both a comma and an embedded double-quote.
const name = 'O\'Brien, Jane "JJ"';

const subject = renderSubject(name);
const body = renderBody(name);

console.log("subject:", JSON.stringify(subject));
console.log("body:", JSON.stringify(body));

assert.equal(
  subject,
  `A quick note just for ${name}`,
  "subject should render name verbatim in place of {{name}}",
);

assert.ok(
  body.startsWith(`Hi ${name},`),
  `body should start with "Hi <name>," verbatim, got: ${JSON.stringify(body)}`,
);

assert.ok(!subject.includes("{{name}}"), "subject placeholder must be fully replaced");
assert.ok(!body.includes("{{name}}"), "body placeholder must be fully replaced");

// Explicitly confirm the comma and embedded quote survive unmangled
// (no HTML-escaping, no CSV-quoting, no backslash-escaping applied).
assert.ok(subject.includes('O\'Brien, Jane "JJ"'), "comma+quote name must appear verbatim in subject");
assert.ok(body.includes('O\'Brien, Jane "JJ"'), "comma+quote name must appear verbatim in body");

// A second edge case: name that itself contains the literal template token,
// to confirm split/join doesn't do anything recursive/unexpected.
const trickyName = "{{name}} the Second";
const trickySubject = renderSubject(trickyName);
assert.equal(trickySubject, `A quick note just for ${trickyName}`);

console.log("PASS: 01-template.test.ts");
