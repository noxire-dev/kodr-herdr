// node mod/herdr-browser/input.check.mjs
import assert from "node:assert/strict";
import { toUrl, keyToCdp, fit, toPage, strip } from "./input.js";

assert.equal(toUrl("3000"), "http://localhost:3000");
assert.equal(toUrl("localhost:5173/app"), "http://localhost:5173/app");
assert.equal(toUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
assert.equal(toUrl("http://x.test"), "http://x.test");
assert.equal(toUrl("about:blank"), "about:blank");
assert.equal(toUrl("example.com/a?b"), "https://example.com/a?b");
assert.equal(toUrl("how to herd"), "https://duckduckgo.com/?q=how%20to%20herd");
assert.equal(toUrl("  "), null);

const k = (key, mods = {}, key_char) => keyToCdp({ key, key_char, modifiers: mods });
assert.equal(k("p", { control: true, shift: true }), null, "Ctrl+Shift chords stay herdr's");
assert.equal(k("shift", { shift: true }), null);
assert.deepEqual(k("c", { control: true }), { copy: true });
assert.deepEqual(keyToCdp({ key: "v", modifiers: { platform: true } }, true), { paste: true }, "Cmd+V on macOS");
assert.equal(keyToCdp({ key: "v", modifiers: { platform: true } }, false).paste, undefined, "Win+V is not paste on Windows");
const a = k("a", {}, "a").send;
assert.equal(a[0].type, "keyDown"); assert.equal(a[0].text, "a"); assert.equal(a[0].windowsVirtualKeyCode, 65); assert.equal(a[1].type, "keyUp");
const enter = k("enter").send;
assert.equal(enter[0].text, "\r"); assert.equal(enter[0].windowsVirtualKeyCode, 13);
assert.equal(k("enter", { shift: true }).send[0].type, "rawKeyDown", "Shift+Enter sends no text");
assert.equal(k("backspace").send[0].type, "rawKeyDown");
assert.deepEqual(k("a", { control: true }).send[0].commands, ["selectAll"]);
assert.equal(k("k", { control: true }).send[0].modifiers, 2);
assert.equal(k("f13"), null);

const box = fit({ width: 1000, height: 500 }, { width: 2000, height: 1000 });
assert.equal(box.scale, 0.5); assert.equal(box.width, 1000);
assert.deepEqual(toPage({ x: 100, y: 50 }, box), { x: 200, y: 100 });
assert.equal(fit(null, { width: 1, height: 1 }), null);

const p = (id, title = id) => ({ id, title });
let s = strip([], [p("b"), p("a")]); // most recently active first
assert.deepEqual(s.tabs.map((t) => t.id), ["a", "b"], "first sight: oldest activity first");
assert.equal(s.front, "b");
s = strip(s.tabs, [p("a", "A2"), p("b")]); // activating a doesn't reorder the strip
assert.deepEqual(s.tabs.map((t) => t.id), ["a", "b"]); assert.equal(s.tabs[0].title, "A2"); assert.equal(s.front, "a");
s = strip(s.tabs, [p("c"), p("b")]); // a closed, c opened (by an agent) and active
assert.deepEqual(s.tabs.map((t) => t.id), ["b", "c"]); assert.equal(s.front, "c");
assert.deepEqual(strip(s.tabs, []), { tabs: [], front: null });
console.log("herdr-browser input check ok");
