// node mod/kodr-pane/attention.check.mjs
import assert from "node:assert/strict";
import { attention, allowed, levelOf } from "./attention.js";
const seen = new Map();
const a = (address, status) => ({ address, status });
assert.deepEqual(attention(seen, [a("t1", "blocked"), a("t2", "working")]), []); // first sight: quiet
assert.deepEqual(attention(seen, [a("t1", "blocked"), a("t2", "done")]).map((x) => [x.agent.address, x.kind]), [["t2", "done"]]);
assert.deepEqual(attention(seen, [a("t1", "working"), a("t2", "idle")]), []);
assert.deepEqual(attention(seen, [a("t1", "blocked"), a("t2", "done")]).map((x) => x.kind), ["blocked"]); // idle -> done isn't new work
assert.deepEqual(attention(seen, [a("t2", "done")]), []);
assert.equal(seen.has("t1"), false); // gone agents are forgotten
// Per space: All lets both through, Needs me only blocked, Off nothing; an unknown space is All.
const news = [{ agent: { space: "s1" }, kind: "blocked" }, { agent: { space: "s1" }, kind: "done" }];
const kinds = (levels) => allowed(news, levels).map((x) => x.kind);
assert.deepEqual(kinds({ s1: "all" }), ["blocked", "done"]);
assert.deepEqual(kinds({ s1: "needs" }), ["blocked"]);
assert.deepEqual(kinds({ s1: "off" }), []);
assert.deepEqual(kinds({ s2: "off" }), ["blocked", "done"]);
assert.deepEqual(kinds(undefined), ["blocked", "done"]);
assert.equal(levelOf({ s1: "bogus" }, "s1"), "all");
console.log("attention: ok");
// Terminal | Chat only while a Claude runs in the pane. After Claude exits back to the shell herdr keeps app
// "claude-code" (status "done" for a while, later null) and hc names the shell as foreground even while Claude runs;
// Kodr's SessionEnd hook marks the session ended, which is what settles it.
const { canChat } = await import("./attention.js");
assert.equal(canChat({ app: "claude-code", status: "idle" }, false), true);
assert.equal(canChat({ program: { key: "claude" }, status: "working" }, false), true);
assert.equal(canChat({ app: "claude-code", status: "done" }, true), false); // exited: SessionEnd marked it
assert.equal(canChat({ app: "claude-code", status: null }, false), false); // exited long ago (the issues pane)
assert.equal(canChat({ app: null, status: null }, false), false); // a plain shell
console.log("panes: ok");
// A pane's title that's only a program's path (a terminal started from argv) gives way to herdr's program name.
const { titleOf } = await import("./attention.js");
assert.equal(titleOf("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), null);
assert.equal(titleOf("/bin/zsh"), null);
assert.equal(titleOf("C:\\tools\\serve"), null); // a Windows path with no .exe
assert.equal(titleOf("npm run dev"), "npm run dev");
assert.equal(titleOf(null), null);
console.log("titles: ok");
