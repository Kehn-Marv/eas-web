import test from "node:test";
import assert from "node:assert/strict";

import {
  applyManualOrder,
  mergeManualOrder,
  moveItem,
  reorderNavSection,
  resolveNavLayout,
  setNavCollapsed,
  type SidebarNavLayout,
} from "../lib/sidebar-layout";

const DEFAULTS = ["/chat", "/learning/mastery", "/folded-feature", "/learning/practice", "/space"];

test("an unsaved layout uses the shipped collapsed defaults", () => {
  const resolved = resolveNavLayout(DEFAULTS, null, ["/folded-feature"]);
  assert.deepEqual(resolved.order, DEFAULTS);
  assert.deepEqual(resolved.visible, DEFAULTS.filter((href) => href !== "/folded-feature"));
  assert.deepEqual(resolved.collapsed, ["/folded-feature"]);
  assert.equal(resolved.customized, false);
});

test("a saved order wins over the shipped one", () => {
  const resolved = resolveNavLayout(DEFAULTS, {
    order: ["/space", "/chat", "/learning/mastery", "/folded-feature", "/learning/practice"],
    collapsed: [],
  });
  assert.deepEqual(resolved.visible, [
    "/space",
    "/chat",
    "/learning/mastery",
    "/folded-feature",
    "/learning/practice",
  ]);
  assert.equal(resolved.customized, true);
});

test("a feature shipped later lands next to the neighbour it follows", () => {
  // The arrangement was saved before /reading existed and moved /space to the
  // top; /reading must arrive after /book (its default predecessor), not at
  // the bottom of whatever the user happened to arrange.
  const defaults = ["/chat", "/learning/mastery", "/learning/practice", "/learning/reading", "/space"];
  const resolved = resolveNavLayout(defaults, {
    order: ["/space", "/chat", "/learning/mastery", "/learning/practice"],
    collapsed: [],
  });
  assert.deepEqual(resolved.visible, [
    "/space",
    "/chat",
    "/learning/mastery",
    "/learning/practice",
    "/learning/reading",
  ]);
});

test("a first feature shipped later lands at the top", () => {
  const resolved = resolveNavLayout(["/new", "/chat", "/space"], {
    order: ["/space", "/chat"],
    collapsed: [],
  });
  assert.deepEqual(resolved.visible, ["/new", "/space", "/chat"]);
});

test("features that no longer exist and duplicates are dropped", () => {
  const resolved = resolveNavLayout(DEFAULTS, {
    order: ["/gone", "/space", "/space", "/chat"],
    collapsed: ["/gone", "/learning/practice"],
  });
  assert.deepEqual(resolved.visible, [
    "/space",
    "/chat",
    "/learning/mastery",
    "/folded-feature",
  ]);
  assert.deepEqual(resolved.collapsed, ["/learning/practice"]);
});

test("the resolved order feeds the next edit even before a first drag", () => {
  // A saved layout starts empty, so the first fold or drag has to work from
  // the resolved order rather than from the stored one.
  const { order, collapsed } = resolveNavLayout(DEFAULTS, null);
  const folded = setNavCollapsed({ order, collapsed }, "/learning/practice", true);
  assert.deepEqual(resolveNavLayout(DEFAULTS, folded).visible, [
    "/chat",
    "/learning/mastery",
    "/folded-feature",
    "/space",
  ]);
  const dragged = reorderNavSection(
    folded,
    resolveNavLayout(DEFAULTS, folded).visible,
    ["/space", "/chat", "/learning/mastery", "/folded-feature"],
  );
  assert.deepEqual(resolveNavLayout(DEFAULTS, dragged).visible, [
    "/space",
    "/chat",
    "/learning/mastery",
    "/folded-feature",
  ]);
});

test("folding a feature keeps its slot for when it comes back", () => {
  let layout: SidebarNavLayout = { order: [...DEFAULTS], collapsed: [] };
  layout = setNavCollapsed(layout, "/folded-feature", true);
  assert.deepEqual(resolveNavLayout(DEFAULTS, layout).visible, [
    "/chat",
    "/learning/mastery",
    "/learning/practice",
    "/space",
  ]);
  assert.deepEqual(resolveNavLayout(DEFAULTS, layout).collapsed, ["/folded-feature"]);

  layout = setNavCollapsed(layout, "/folded-feature", false);
  assert.deepEqual(resolveNavLayout(DEFAULTS, layout).visible, DEFAULTS);
});

test("dragging the visible list leaves folded features pinned", () => {
  const layout: SidebarNavLayout = {
    order: [...DEFAULTS],
    collapsed: ["/folded-feature"],
  };
  const { visible } = resolveNavLayout(DEFAULTS, layout);
  const next = reorderNavSection(layout, visible, moveItem(visible, 3, 0));
  const after = resolveNavLayout(DEFAULTS, next);
  assert.deepEqual(after.visible, ["/space", "/chat", "/learning/mastery", "/learning/practice"]);
  // Unfolding still returns /folded-feature to the third slot it has always held.
  assert.deepEqual(
    resolveNavLayout(DEFAULTS, setNavCollapsed(next, "/folded-feature", false)).visible,
    ["/space", "/chat", "/folded-feature", "/learning/mastery", "/learning/practice"],
  );
});

test("reordering a section rejects a mismatched section", () => {
  const layout: SidebarNavLayout = { order: [...DEFAULTS], collapsed: [] };
  assert.deepEqual(
    reorderNavSection(layout, DEFAULTS, ["/chat", "/space"]),
    layout,
  );
});

test("moveItem is a no-op outside the list", () => {
  assert.deepEqual(moveItem(["a", "b"], 0, 0), ["a", "b"]);
  assert.deepEqual(moveItem(["a", "b"], 5, 0), ["a", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 2, 0), ["c", "a", "b"]);
});

interface Row {
  id: string;
}
const rows = (...ids: string[]): Row[] => ids.map((id) => ({ id }));
const idOf = (row: Row) => row.id;

test("an untouched list keeps the server order", () => {
  assert.deepEqual(
    applyManualOrder(rows("a", "b", "c"), idOf, []),
    rows("a", "b", "c"),
  );
});

test("arranged rows hold their place and new rows arrive on top", () => {
  const arranged = applyManualOrder(rows("new", "a", "b", "c"), idOf, [
    "c",
    "a",
    "b",
  ]);
  assert.deepEqual(arranged, rows("new", "c", "a", "b"));
});

test("a new conversation lands where recency puts it, not below the arrangement", () => {
  // Server order [a, new, b, c] under the arrangement [c, a, b]: the new row
  // keeps the slot its timestamp earned, and a, b, c fill the rest in the
  // order the user dragged them into.
  assert.deepEqual(
    applyManualOrder(rows("a", "new", "b", "c"), idOf, ["c", "a", "b"]),
    rows("c", "new", "a", "b"),
  );
});

test("an arranged row that disappeared costs nothing", () => {
  assert.deepEqual(
    applyManualOrder(rows("a", "c"), idOf, ["c", "b", "a"]),
    rows("c", "a"),
  );
});

test("a drag rearranges the rows it saw and leaves the rest alone", () => {
  // Stored [a,b,c,d]; only a and c were on screen and the user swapped them.
  // b and d were never dragged, so they hold the exact index they had — a
  // drag moves what you dragged and nothing else.
  const merged = mergeManualOrder(["a", "b", "c", "d"], ["c", "a"]);
  assert.deepEqual(merged, ["c", "b", "a", "d"]);
  assert.deepEqual(
    applyManualOrder(rows("a", "b", "c", "d"), idOf, merged),
    rows("c", "b", "a", "d"),
  );
});

test("a row dragged for the first time joins where it was dropped", () => {
  // Stored [c,a,b]; "new" arrived on top, unarranged, and the user dropped it
  // between c and a.
  const merged = mergeManualOrder(["c", "a", "b"], ["c", "new", "a", "b"]);
  assert.deepEqual(merged, ["c", "new", "a", "b"]);
  assert.deepEqual(
    applyManualOrder(rows("new", "a", "b", "c"), idOf, merged),
    rows("c", "new", "a", "b"),
  );
});

test("a first drag adopts the rows it saw", () => {
  const merged = mergeManualOrder([], ["b", "a"]);
  assert.deepEqual(merged, ["b", "a"]);
  assert.deepEqual(
    applyManualOrder(rows("a", "b"), idOf, merged),
    rows("b", "a"),
  );
});


test("a deliberately saved empty collapsed list overrides new defaults", () => {
  const resolved = resolveNavLayout(DEFAULTS, { order: DEFAULTS, collapsed: [] }, ["/folded-feature"]);
  assert.deepEqual(resolved.visible, DEFAULTS);
  assert.deepEqual(resolved.collapsed, []);
  assert.equal(resolved.customized, true);
});
