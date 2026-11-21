// node mod/kodr-mission/board.check.mjs
import assert from "node:assert/strict";
import { lanes, folderOf, mergeStep } from "./board.js";
const c = (number, column, extra = {}) => ({ number, column, title: `Card ${number}`, ...extra });
const board = { viewer: "me", cycle: { open: [3, 2] }, columns: {
  future: [c(9, "future")], todo: [c(4, "todo"), c(5, "todo", { waiting: true })],
  ongoing: [c(1, "ongoing"), c(2, "ongoing", { assignees: ["me"] }), c(3, "ongoing")], "in-review": [], blocked: [],
  done: [c(7, "done", { waiting: true, assignees: ["me"] })] } };
const ns = (r) => Object.fromEntries(r.lanes.map((l) => [l.key, l.cards.map((x) => x.number)]));
assert.deepEqual(ns(lanes(board)), { todo: [5, 4], ongoing: [3, 2, 1], "in-review": [], blocked: [] }); // waiting, then cycle order
assert.deepEqual(lanes(board).counts, { all: 6, cycle: 2, waiting: 1, mine: 1 }); // done never counts
assert.deepEqual(ns(lanes(board, { filter: "cycle" })).ongoing, [3, 2]);
assert.deepEqual(ns(lanes(board, { query: "#4" })).todo, [4]);
assert.deepEqual(ns(lanes(board, { extra: true })).done, [7]);
assert.deepEqual(lanes({ columns: { todo: [c(1, "todo")] } }).counts.cycle, 0); // no cycle key
const sp = { id: "s1", folder: "C:/home", tabs: [{ id: "tb1" }] };
assert.equal(folderOf(sp, [{ tab: "tb9", cwd: "C:/other" }, { tab: "tb1", cwd: null }, { tab: "tb1", cwd: "C:/repo" }]), "C:/repo");
assert.equal(folderOf(sp, []), "C:/home");
assert.equal(folderOf(null, []), null);
// Merge opens only after a clean review of the commit that's checked out; a newer commit goes up first.
const clean = { state: "done", fix: 0, head: "a" };
assert.equal(mergeStep(null, null, "a"), "review");
assert.equal(mergeStep({ state: "running" }, null, "a"), "review");
assert.equal(mergeStep({ ...clean, fix: 1 }, null, "a"), "review");
assert.equal(mergeStep(clean, null, "b"), "review"); // stale
assert.equal(mergeStep({ ...clean, dirty: true }, null, "a"), "review");
assert.equal(mergeStep(clean, null, "a"), "open");
assert.equal(mergeStep({ ...clean, empty: true }, null, "a"), "empty"); // no commits yet: nothing to open a PR for
assert.equal(mergeStep(clean, { number: 4, head: "old" }, "a"), "push");
assert.equal(mergeStep(clean, { number: 4, head: "a" }, "a"), "merge");
assert.equal(mergeStep(null, { number: 4, merged: true }, "z"), "merged");
console.log("board: ok");
