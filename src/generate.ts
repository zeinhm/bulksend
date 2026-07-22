import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { finished } from "node:stream/promises";

const FIRST_NAMES = [
  "Olivia", "Liam", "Emma", "Noah", "Ava", "Mateo", "Sofia", "Ethan", "Mia",
  "Lucas", "Chidi", "Priya", "Hiro", "Fatima", "Anders", "Yara", "Kwame",
  "Ingrid", "Diego", "Aaliyah",
];

const LAST_NAMES = [
  "Nguyen", "Garcia", "Smith", "Kowalski", "Andersson", "Okafor", "Tanaka",
  "Silva", "Kumar", "Novak", "Larsen", "Haddad", "Petrov", "Costa", "Diallo",
  "Berg", "Rossi", "Kaur", "Meyer", "Osei",
];

// deliberately gnarly names to force the csv quoting path
const EDGE_CASE_NAMES = [
  'Smith, John',
  'O\'Brien, Jane "JJ"',
  '"Big Papa" Johnson, Marcus',
  'Wells, Sarah, Jr.',
  'Müller, Hans "The Hammer"',
  'Doe, "Q"',
  'Comma, Comma, Comma',
];

function nameFor(i: number): string {
  if (i % 97 === 0) {
    return EDGE_CASE_NAMES[(i / 97) % EDGE_CASE_NAMES.length]!;
  }
  const first = FIRST_NAMES[i % FIRST_NAMES.length]!;
  const last = LAST_NAMES[(i * 7) % LAST_NAMES.length]!;
  return `${first} ${last}`;
}

function emailFor(i: number, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  // .test is reserved by RFC 2606 and guaranteed never to resolve
  return `${slug || "recipient"}.${i}@example.test`;
}

function csvField(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

async function writeLine(ws: NodeJS.WritableStream, line: string): Promise<void> {
  if (!ws.write(line)) {
    await once(ws, "drain");
  }
}

export async function generate(count: number, outPath: string): Promise<void> {
  const ws = createWriteStream(outPath, { encoding: "utf8" });

  await writeLine(ws, "email,name\n");
  for (let i = 0; i < count; i++) {
    const name = nameFor(i);
    const email = emailFor(i, name);
    await writeLine(ws, `${csvField(email)},${csvField(name)}\n`);
  }

  ws.end();
  await finished(ws);
}
