import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeResourceSegment,
  knowledgeBaseRoute,
  notebookRoute,
} from "../lib/resource-routes";

test("resource identities are encoded as path segments", () => {
  assert.equal(notebookRoute("notes/café"), "/notebooks/notes%2Fcaf%C3%A9");
  assert.equal(
    knowledgeBaseRoute("calculus / advanced"),
    "/knowledge-bases/calculus%20%2F%20advanced",
  );
});

test("dynamic resource parameters decode back to stored identities", () => {
  assert.equal(
    decodeResourceSegment("global%20health"),
    "global health",
  );
  assert.equal(decodeResourceSegment("calculus%20%2F%20advanced"), "calculus / advanced");
  assert.equal(decodeResourceSegment("100%25%20coverage"), "100% coverage");
  assert.equal(decodeResourceSegment(null), null);
});

test("filters remain query state rather than resource identity", () => {
  assert.equal(notebookRoute(null, "course one"), "/notebooks?course=course%20one");
  assert.equal(
    notebookRoute("notes", "course one"),
    "/notebooks/notes?course=course%20one",
  );
});
