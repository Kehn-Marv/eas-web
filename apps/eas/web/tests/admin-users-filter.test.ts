import test from "node:test";
import assert from "node:assert/strict";

import { filterUsersByQuery } from "../lib/admin-users";

function user(username: string): { id: string; username: string } {
  return { id: `u_${username}`, username };
}

const USERS = [user("Alice"), user("bob"), user("alice.smith"), user("Charlie")];

test("empty or whitespace-only query returns the list unchanged", () => {
  assert.equal(filterUsersByQuery(USERS, ""), USERS);
  assert.equal(filterUsersByQuery(USERS, "   "), USERS);
});

test("matching is case-insensitive and substring-based", () => {
  assert.deepEqual(
    filterUsersByQuery(USERS, "ALICE").map((u) => u.username),
    ["Alice", "alice.smith"],
  );
  assert.deepEqual(
    filterUsersByQuery(USERS, "smith").map((u) => u.username),
    ["alice.smith"],
  );
});

test("query is trimmed before matching", () => {
  assert.deepEqual(
    filterUsersByQuery(USERS, "  bob  ").map((u) => u.username),
    ["bob"],
  );
});

test("mixed-case usernames are searchable by lowercase prefix", () => {
  assert.deepEqual(
    filterUsersByQuery(USERS, "char").map((u) => u.username),
    ["Charlie"],
  );
});

test("no match yields an empty list, not an error", () => {
  assert.deepEqual(filterUsersByQuery(USERS, "zzz"), []);
  assert.deepEqual(filterUsersByQuery([], "alice"), []);
});
