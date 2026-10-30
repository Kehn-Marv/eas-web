import test from "node:test";
import assert from "node:assert/strict";

import {
  displaySessionTitle,
  isPlaceholderSessionTitle,
} from "../lib/session-title";

test("empty and backend-default session titles are placeholders", () => {
  assert.equal(isPlaceholderSessionTitle(""), true);
  assert.equal(isPlaceholderSessionTitle("  New conversation  "), true);
});

test("user and generated session titles remain business data", () => {
  assert.equal(isPlaceholderSessionTitle("New Conversation"), true);
  assert.equal(isPlaceholderSessionTitle("Fourier Transform"), false);
});

test("the main-pane New chat placeholder is not shown as a session title", () => {
  assert.equal(isPlaceholderSessionTitle("New chat"), true);
  assert.equal(isPlaceholderSessionTitle("  NEW CHAT  "), true);
});

test("displaySessionTitle localizes placeholders for history picker and lists", () => {
  assert.equal(displaySessionTitle("", "New Thread"), "New Thread");
  assert.equal(displaySessionTitle("New conversation", "New Thread"), "New Thread");
  assert.equal(displaySessionTitle("  New conversation  ", "New Thread"), "New Thread");
  assert.equal(displaySessionTitle("Fourier Transform", "New Thread"), "Fourier Transform");
});
