import test from "node:test";
import assert from "node:assert/strict";

import {
  toolAvailabilityCopy,
  toolEffectiveEnabled,
} from "../lib/tool-availability";

test("configured runtime and saved preference are both required", () => {
  assert.equal(toolEffectiveEnabled(true, true, false), true);
  assert.equal(toolEffectiveEnabled(true, false, false), false);
  assert.equal(toolEffectiveEnabled(false, true, false), false);
  assert.equal(toolEffectiveEnabled(true, true, true), false);
});

test("search provider readiness points learners to provider settings", () => {
  assert.deepEqual(
    toolAvailabilityCopy("search_provider_not_configured", "en"),
    {
      badge: "Not configured",
      detail:
        "Choose a provider in Search settings first. DuckDuckGo needs no API key.",
      href: "/settings/providers?tab=search",
    },
  );
});
