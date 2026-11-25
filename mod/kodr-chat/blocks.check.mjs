// node mod/kodr-chat/blocks.check.mjs
import assert from "node:assert/strict";
import { splitBlocks, fenced } from "./blocks.js";

const kinds = (md) => splitBlocks(md).map((b) => b.kind).join(",");

assert.deepEqual(splitBlocks("just prose\n\nmore"), [{ kind: "md", text: "just prose\n\nmore" }]);

const r = splitBlocks("Run it:\n\n```\nnode bin/install.mjs --global\n```\n\nThat's all.");
assert.equal(kinds("Run it:\n\n```\nnode x\n```\n\nThat's all."), "md,code,md");
assert.equal(r[1].code, "node bin/install.mjs --global");
assert.equal(r[1].lang, "");

// language tag, tilde fences, a ``` inside a ```` block
assert.equal(splitBlocks("```js\nlet a = 1;\n```")[0].lang, "js");
assert.equal(splitBlocks("~~~\na\n~~~")[0].code, "a");
assert.equal(splitBlocks("````md\n```\ninner\n```\n````")[0].code, "```\ninner\n```");

// a block indented under a list item loses that indent in the copy
const li = splitBlocks("1. Do:\n   ```\n   npm i\n   ```\n2. Then");
assert.equal(kinds("1. Do:\n   ```\n   npm i\n   ```\n2. Then"), "md,code,md");
assert.equal(li[1].code, "npm i");

// mid-reply: an unclosed fence runs to the end
assert.equal(splitBlocks("```\nhalf")[0].code, "half");

// inline code never splits
assert.equal(kinds("use `node x` here, ``a``"), "md");

// round trip for drawing
assert.equal(fenced({ fence: "```", lang: "sh", code: "ls" }), "```\nls\n```");
assert.equal(li[1].indent, 3);

console.log("blocks ok");

// find in chat: rows that hold the query (any case, tool line and output too), marks that keep the markdown intact
import { hits, markMarkdown, rowText } from "./find.js";
const rows = [{ kind: "user", text: "Where is the Fan curve?" }, { kind: "tool", summary: "Grep FanCurve", output: "app/Fans.cs" },
  { kind: "end", ms: 1 }, { kind: "text", text: "no match here" }, { kind: "thinking", text: "fan speed" }];
const at = (q, r = rows) => hits(r, q).map(({ i, k }) => `${i}.${k}`);
assert.deepEqual(at("fan"), ["0.0", "1.0", "4.0"]);
// Each match counts, a code block's don't (they aren't marked): "fan fan" + a fenced fan = 2 hits.
assert.deepEqual(at("fan", [{ kind: "text", text: "fan and fan\n```\nfan\n```" }]), ["0.0", "0.1"]);
assert.deepEqual(at("a.c"), []); // the query is literal, not a pattern
assert.deepEqual(at("Fans.cs"), ["1.0"]);
assert.deepEqual(hits(rows, ""), []);
assert.equal(rowText({ kind: "end" }), "");
const M = (s) => `<mark style="background-color: c">${s}</mark>`;
assert.equal(markMarkdown("the Fan and fan", "fan", "c"), `the ${M("Fan")} and ${M("fan")}`);
assert.equal(markMarkdown("- **fan** item", "fan", "c"), `- **${M("fan")}** item`);
assert.equal(markMarkdown("see `fan.js` and [fan](http://x/fan)", "fan", "c"), `see ${M("`fan.js`")} and [${M("fan")}](http://x/fan)`);
assert.equal(markMarkdown("```\nfan\n```\nfan", "fan", "c"), `\`\`\`\nfan\n\`\`\`\n${M("fan")}`);
assert.equal(markMarkdown("| fan |", "fan", "c"), "| fan |");
// The current match (numbered across the row from start) is the only bright one.
const C = (x) => `<mark style="background-color: #f59e0bcc">${x}</mark>`;
assert.equal(markMarkdown("fan fan", "fan", "c", 1), `${M("fan")} ${C("fan")}`);
assert.equal(markMarkdown("fan", "fan", "c", 2, 2), C("fan"));
console.log("blocks + find: ok");

// A terminal draft: the input box between the last two rules; wrapped lines join, real line breaks stay.
import { draftOf, clearKeys } from "./draft.js";
const RULE = "─".repeat(30);
const box = (...l) => ["● Earlier.", "", RULE, ...l, RULE, "  ⏵⏵ bypass permissions on"].join("\n");
assert.deepEqual(draftOf(box("❯ ")), { text: "", lines: 0 });
assert.deepEqual(draftOf(box('❯ Try "fix lint errors"')), { text: "", lines: 0 });
assert.deepEqual(draftOf(box("❯ hello draft")), { text: "hello draft", lines: 1 });
assert.deepEqual(draftOf(box("❯ first", "  second", "  " + "w".repeat(27), "  rest")), { text: "first\nsecond\n" + "w".repeat(27) + " rest", lines: 4 });
assert.deepEqual(draftOf("❯ no box here"), { text: "", lines: 0 });
assert.deepEqual(draftOf(box(" Do you want to proceed?", " ❯ 1. Yes")), { text: "", lines: 0 }); // a dialog, not the input
assert.deepEqual(clearKeys(1), ["ctrl+e", "ctrl+u"]);
assert.deepEqual(clearKeys(3), ["ctrl+e", "ctrl+u", "backspace", "ctrl+u", "backspace", "ctrl+u"]);
console.log("draft: ok");
