// node mod/kodr-chat/turns.check.mjs
import assert from "node:assert/strict";
import { turns, summary } from "./turns.js";

const u = (text) => ({ kind: "user", text });
const say = (text) => ({ kind: "text", text });
const tool = (id, extra = {}) => ({ kind: "tool", id, name: "Bash", summary: `cmd ${id}`, state: "ok", ...extra });
const end = (ms) => ({ kind: "end", ms });

// A finished turn: narration and tools fold, the last text is the answer.
const done = turns([u("go"), { kind: "thinking", text: "hm" }, say("Looking."), tool("a"), tool("b", { diff: ["-x", "+y", "+z"], summary: "a.js" }), say("Done."), end(92700)]);
assert.deepEqual(done.map((x) => x.kind), ["user", "turn"]);
const t = done[1];
assert.equal(t.answer.text, "Done.");
assert.deepEqual(t.work.map((r) => r.kind), ["thinking", "text", "tool", "tool"]);
assert.deepEqual(t.stats, { tools: 2, edits: 1, failed: 0, thoughts: 1 });
assert.deepEqual(t.files, [{ file: "a.js", add: 2, del: 1 }]);
assert.equal(summary(t, t.end.ms), "Worked for 1m 33s · 2 tool calls · 1 edit");
assert.equal(t.answer._i, 5); // rows keep their index, for stable keys

// Still working: a text followed by nothing yet is narration, not the answer; a pending ask stays out of the fold.
const live = turns([u("go"), say("Checking."), tool("c", { state: "running", ask: { state: "pending" } })])[1];
assert.equal(live.answer, null);
assert.deepEqual(live.asks.map((r) => r.id), ["c"]);
assert.equal(summary(live, 12_000, true), "Working for 12s · 1 tool call");

// A text that ends the transcript without an end row (Claude about to stop) isn't taken as the answer yet.
assert.equal(turns([u("go"), say("ok")], true)[1].answer, null);
// Over without an end row (Claude idle, or another message came): the last text is the answer, not hidden in the fold.
assert.equal(turns([u("go"), tool("a"), say("Handed off.")])[1].answer.text, "Handed off.");
assert.equal(turns([u("go"), say("first"), u("again"), say("second")], true)[1].answer.text, "first");
// A steer: the Interrupted note sits before the message that interrupted, after the turn it ended.
assert.deepEqual(turns([u("run"), tool("a"), u("steer"), { kind: "note", text: "Interrupted" }, say("ok"), end(1)]).map((x) => x.kind === "aside" ? x.row.text : x.kind === "user" ? x.row.text : x.kind),
  ["run", "turn", "Interrupted", "steer", "turn"]);
// Only thinking: "Thought for 4s".
assert.equal(summary(turns([u("q"), { kind: "thinking", text: "h" }, say("a"), end(4000)])[1], 4000), "Thought for 4s");

// yap and notes stand apart; a turn of nothing but an end row disappears; rows before any message make a turn.
const mixed = turns([say("hello"), end(1000), u("x"), { kind: "note", text: "Interrupted" }, end(0)]);
assert.deepEqual(mixed.map((x) => x.kind), ["turn", "user", "aside", "turn"]);
assert.equal(mixed[0].answer.text, "hello");

// A crew card (a goal handed to yap's crew) stands outside the turn's fold, after the turn that made it.
const crewed = turns([u("split it"), { kind: "tool", name: "Bash", summary: "yap goal x" }, { kind: "crew", goal: 3 }, say("handed it"), end(9)]);
assert.deepEqual(crewed.map((x) => x.kind), ["user", "turn", "aside"]);
assert.deepEqual([crewed[1].work.length, crewed[1].answer.text, crewed[2].row.goal], [1, "handed it", 3]);

console.log("turns: ok");
