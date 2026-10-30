import test from "node:test";
import assert from "node:assert/strict";

import { clipLabel, formatProgressLabel } from "../lib/trace-tools";

test("a short label is untouched", () => {
  assert.equal(clipLabel("fetching pages", 40), "fetching pages");
});

test("a long label is clipped on a word boundary when one is near the cut", () => {
  const clipped = clipLabel(
    "fetching page seventeen of two hundred and twelve",
    20,
  );
  assert.ok(clipped.endsWith("…"));
  assert.ok(!clipped.includes("seventee…"), `mid-word cut: ${clipped}`);
  assert.ok(clipped.length <= 21);
});

test("a long unbroken label is still cut rather than overflowing", () => {
  const clipped = clipLabel("a".repeat(80), 20);
  assert.equal(clipped, `${"a".repeat(20)}…`);
});

test("surrounding whitespace never survives into the row", () => {
  assert.equal(formatProgressLabel("  indexing  "), "indexing");
});

