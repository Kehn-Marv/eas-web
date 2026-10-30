import test from "node:test";
import assert from "node:assert/strict";
import { settingsAnchorHref, SETTINGS_CATEGORIES } from "../features/settings/navigation/settings-nav";
import {
  legacySettingsDestination,
  visibleSettingsPages,
  settingsPageFamily,
  SETTINGS_PAGE_GROUPS,
} from "../features/settings/navigation/settings-pages";

const admin = {
  resolved: true,
  hideAdminOnly: false,
  showLearnerOnly: false,
  showGuardianOnly: false,
};

test("legacy settings bookmarks resolve to current pages, preserving profile links", () => {
  assert.equal(legacySettingsDestination("", ""), "/settings/appearance");
  assert.equal(legacySettingsDestination("#overview", ""), "/settings/appearance");
  assert.equal(
    legacySettingsDestination("#document-parsing", ""),
    "/settings/knowledge",
  );
  assert.equal(
    legacySettingsDestination("#llm?profile=old%20id", ""),
    "/settings/providers?tab=language&profile=old+id",
  );
  assert.equal(
    legacySettingsDestination("#llm", "?profile=old-id"),
    "/settings/providers?tab=language&profile=old-id",
  );
  assert.equal(legacySettingsDestination("#%invalid", ""), "/settings/appearance");
  for (const category of SETTINGS_CATEGORIES) {
    for (const leaf of category.children ?? [category]) {
      assert.equal(
        legacySettingsDestination(`#${leaf.key}`, ""),
        settingsAnchorHref(leaf.key),
      );
    }
  }
});

test("every available setting is reachable through a navigation family", () => {
  const reachable = new Set(
    SETTINGS_PAGE_GROUPS.flatMap(group =>
      group.keys.flatMap(settingsPageFamily),
    ),
  );
  for (const page of visibleSettingsPages({
    ...admin,
    showLearnerOnly: true,
    showGuardianOnly: true,
  })) {
    assert.ok(reachable.has(page.key), page.key);
  }
});

test("removed settings pages do not appear in navigation", () => {
  const keys = visibleSettingsPages({
    ...admin,
    hideAdminOnly: true,
    showLearnerOnly: true,
  }).map(page => page.key);
  assert.ok(keys.includes("learner-profile"));
  assert.ok(!keys.includes("guardian"));
  for (const removed of ["attachments", "agent-codex", "network", "workspace", "about", "runtime", "usage", "migration", "memory", "conversation", "capabilities", "partners"]) {
    assert.ok(!keys.includes(removed), removed);
  }
});

test("model and service settings open as tabs inside Providers", () => {
  for (const [key, tab] of Object.entries({
    llm: "language",
    embedding: "embeddings",
    search: "search",
    voice: "voice",
    tts: "voice",
    stt: "voice",
    multimodal: "multimodal",
    imagegen: "multimodal",
    videogen: "multimodal",
  })) {
    assert.equal(settingsAnchorHref(key), `/settings/providers?tab=${tab}`);
  }
  assert.equal(settingsAnchorHref("task-models"), "/settings/providers?tab=tasks");
});
