import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const appearancePagePath = path.join(
  process.cwd(),
  "features",
  "settings",
  "sections",
  "AppearanceSettingsSection.tsx",
);

function readAppearancePage() {
  return fs.readFileSync(appearancePagePath, "utf8");
}

test("appearance source contract: only theme preferences are shown", () => {
  const source = readAppearancePage();

  const themeIndex = source.indexOf('title={t("Theme")}');

  assert.notEqual(themeIndex, -1, "Theme section should exist");
  assert.doesNotMatch(source, /Code blocks|Syntax theme|Show line numbers|Wrap long lines/);
});
