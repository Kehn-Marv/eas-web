import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// Whisper is part of the English-only interface. Keep all visible copy in the
// English catalog and ensure the retired locale catalogs stay out of the app.

function findWebRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "package.json")) && fs.existsSync(path.join(dir, "locales", "en", "app.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the web root from " + __dirname);
}

const WEB = findWebRoot();

const SOURCES = [
  "app/(workspace)/whisper/page.tsx",
  "components/whisper/WhisperComposer.tsx",
  "components/whisper/WhisperMessageList.tsx",
  "components/whisper/WhisperRoomChip.tsx",
];

// `t("…")` but not `setDraft("")` — the negative lookbehind keeps identifiers
// that merely end in `t` from matching.
const T_CALL = /(?<![\w$])t\(\s*"((?:[^"\\]|\\.)+)"/g;

function keysUsed(): string[] {
  const keys = new Set<string>();
  for (const rel of SOURCES) {
    const src = fs.readFileSync(path.join(WEB, rel), "utf8");
    for (const m of src.matchAll(T_CALL)) keys.add(m[1]);
  }
  return [...keys].sort();
}

function locale(name: string): Record<string, string> {
  return JSON.parse(
    fs.readFileSync(path.join(WEB, "locales", name, "app.json"), "utf8"),
  ) as Record<string, string>;
}

test("the whisper surface actually calls t() for its copy", () => {
  // Guards the regex itself: if these files stop using t(), the assertions
  // below would pass vacuously.
  assert.ok(
    keysUsed().length >= 25,
    `expected the whisper files to translate their copy, found ${keysUsed().length} keys`,
  );
});

test("every whisper translation key exists in the English catalog", () => {
  const en = locale("en");
  const missing = keysUsed().filter((k) => !(k in en));
  assert.deepEqual(
    missing,
    [],
    `keys missing from English (they would render as raw copy): ${missing.join(", ")}`,
  );
});

test("the app ships no retired non-English interface catalogs", () => {
  const locales = fs.readdirSync(path.join(WEB, "locales"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(locales, ["en"]);
});

test("no hardcoded Chinese copy is left in the whisper components", () => {
  // The End-session button used to be hardcoded in the JSX, which showed
  // untranslated copy to users. Copy belongs in the locale files.
  //
  // Only the components are checked.
  const offenders: string[] = [];
  for (const rel of SOURCES.filter((f) => f.startsWith("components/"))) {
    const src = fs.readFileSync(path.join(WEB, rel), "utf8");
    if (/[\u4e00-\u9fff]/.test(src)) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `CJK copy left in source: ${offenders.join(", ")}`,
  );
});
