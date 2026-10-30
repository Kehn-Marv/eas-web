import test from "node:test";
import assert from "node:assert/strict";

import { topicDisplayName } from "../components/space/learning/format";

/** Stands in for i18next's `t`: resolves a key, does not pick a language. */
const t = (key: string) => ({ "Exploration trail": "Exploration Trail" })[key] ?? key;

test("mastery topic display names preserve authored titles", () => {
  assert.equal(
    topicDisplayName(
      { name: "Agentic RAG Core Architecture", path_id: "unified_1_abcd" },
      t,
    ),
    "Agentic RAG Core Architecture",
  );
});

test("legacy generated topic ids become friendly traceable labels", () => {
  assert.equal(
    topicDisplayName(
      {
        name: "unified_1787837164040_28bb00dc",
        path_id: "unified_1787837164040_28bb00dc",
      },
      t,
    ),
    "Exploration Trail · 00dc",
  );
});
