// node tools.check.mjs: the agent tools against a fake CDP (no browser).
import assert from "node:assert/strict";
import { CdpBrowser, handle, pageJs } from "./tools.mjs";

// Targets in activation order, a window per target, and an isolated world that a navigation destroys.
const tabs = [
  { id: "A", type: "page", title: "Shop", url: "https://shop.test/", win: 1 },
  { id: "B", type: "page", title: "Docs", url: "https://docs.test/", win: 2 },
];
const log = [];
const worlds = new Set();
let ctx = 0;
const cdp = {
  closed: false,
  async list() { return tabs; },
  async send(method, params = {}, session) {
    log.push([method, params]);
    switch (method) {
      case "Target.attachToTarget": return { sessionId: `s-${params.targetId}` };
      case "Browser.getWindowForTarget": return { windowId: tabs.find((t) => t.id === params.targetId).win };
      case "Target.createTarget": tabs.push({ id: "C", type: "page", title: "", url: "about:blank", win: params.windowId }); return { targetId: "C" };
      case "Target.activateTarget": { const i = tabs.findIndex((t) => t.id === params.targetId); tabs.unshift(...tabs.splice(i, 1)); return {}; }
      case "Page.getFrameTree": return { frameTree: { frame: { id: "f", url: tabs.find((t) => `s-${t.id}` === session).url } } };
      case "Page.createIsolatedWorld": worlds.add(++ctx); return { executionContextId: ctx };
      case "Page.navigate": worlds.clear(); tabs.find((t) => `s-${t.id}` === session).url = params.url; return {};
      case "Runtime.evaluate": {
        if (params.contextId && !worlds.has(params.contextId)) throw new Error("Cannot find context with specified id");
        const e = params.expression;
        if (e.includes("readyState")) return { result: { value: "complete" } };
        if (e.includes('"readPage"')) return { result: { value: { title: "Shop", url: "https://shop.test/", text: "Hi", lines: ['[1] button "Buy"'] } } };
        if (e.includes('"describe"')) return { result: { value: e.includes("(...[9") ? false : "Buy" } };
        return { result: { value: true } };
      }
      default: return {};
    }
  },
};
const textOf = (c) => c.map((x) => x.text).join("");
const b = new CdpBrowser(async () => cdp, pageJs(), 0);

assert.match(textOf(await b.call("list_tabs", {})), /^1 \(active, pane 1\) Shop — https:\/\/shop\.test\/\n2 \(pane 2\) Docs/);

// read_page injects the page script once into an isolated world, then reuses it
assert.match(textOf(await b.call("read_page", {})), /Shop\nhttps:\/\/shop\.test\/\n\nHi\n\nInteractive elements:\n\[1\] button "Buy"/);
await b.call("click", { ref: 1 });
assert.equal(log.filter(([m]) => m === "Page.createIsolatedWorld").length, 1);
assert.match(log.find(([m, p]) => m === "Runtime.evaluate" && p.contextId)[1].expression, /globalThis\.__herdrBrowser = /);
await assert.rejects(b.call("click", { ref: 9 }), /refs are stale/);

// switching makes B active; a new tab opens in the active tab's window (pane) and becomes active
await b.call("switch_tab", { tabId: 2 });
assert.equal(tabs[0].id, "B");
assert.match(textOf(await b.call("navigate", { url: "https://new.test/", new_tab: true })), /Loaded tab 3/);
assert.deepEqual(log.find(([m]) => m === "Target.createTarget")[1], { url: "about:blank", windowId: 2 });
assert.equal(tabs[0].id, "C");

// a navigation destroys the world: the next call makes a new one instead of failing
await b.call("navigate", { url: "https://shop.test/2", tabId: 1 });
await b.call("scroll", { direction: "down", tabId: 1 });
assert.equal(log.filter(([m]) => m === "Page.createIsolatedWorld").length, 2);

await assert.rejects(b.call("navigate", { url: "file:///etc/passwd" }), /Only http/);
await assert.rejects(b.call("read_page", { tabId: 42 }), /No tab 42/);

// MCP: tools/call runs `before` (open the pane) first; errors come back as isError, unknown tools never reach it
let opened = 0;
const before = async () => { opened++; };
const listed = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, b, before);
assert.deepEqual(listed.result.tools.map((t) => t.name), ["list_tabs", "navigate", "switch_tab", "close_tabs", "read_page", "click", "type", "scroll", "screenshot"]);
const r = await handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_tabs" } }, b, before);
assert.equal(opened, 1);
assert.ok(!r.result.isError);
const bad = await handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "upload_file" } }, b, before);
assert.equal(bad.result.isError, true);
assert.equal(opened, 1);
assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, b, before), null);
console.log("herdr-browser tools check ok");
