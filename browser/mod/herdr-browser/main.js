// Browser pane: a window of a headless Chromium (browser.mjs starts it, one per machine on CDP port 9333), drawn
// from CDP screencast frames, with clicks, wheel and keys sent back over CDP. Each pane owns one Chromium window;
// its tabs are that window's pages. Agents drive the same Chromium (the herdr-browser MCP server, tools.mjs;
// Playwright connectOverCDP works too), and a tab they open or switch to in this window shows here.
// Props: { url, key }. The pane remembers its tab (localStorage, per props), so a restored layout or a reload
// reattaches to its window; key (any unique string) keeps two panes on the same URL apart.
//
// Herdr can't embed a webview, and fs.writeFile drops binary data, so each JPEG frame is written as a small SVG
// wrapping it as a data URL, a new file per frame in mods/herdr-browser-frames: herdr reloads a changed image only
// under mods/, and a write inside a mod's own folder reloads that mod.
// ponytail: a frame is a ~300 KB file write, and the strip polls /json/list (the only place CDP says which tab was
// activated); a native webview element in herdr-app replaces both.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, theme, props, home, appHome, readTextFile, checking, nextCommand, window as win } from "herdr";
import { WebSocket } from "websocket";
import * as fs from "fs/promises";
import { toUrl, keyToCdp, fit, toPage, strip } from "./input.js";

const DIR = "mods/herdr-browser-frames";
const ICON = "mods/herdr-browser";
const BAR = 34; // toolbar height
const TABS = 28; // tab strip height, shown with two tabs or more
const POLL = 700;
const SETTLE = 1000; // ms a frame stays on screen before it counts as loaded
const GAP = 250; // ms between frames at most: herdr decodes each one as a new image
const KEEP = 40; // frame files kept; the ones still on screen are never removed

export default class Browser extends View {
  init(_p, cx) {
    this.url = props()?.url || "about:blank";
    // What this pane keeps across reloads, keyed by its props: herdr's localStorage is shared by every pane (and mod),
    // so a fixed key made every pane reattach to the same tab and write the same frame files.
    this.store = `herdr-browser:${props()?.key ?? ""}:${this.url}`;
    // Frame files are named per pane and kept across reloads (which skip close()), so they never pile up.
    let id = null;
    try { id = localStorage.getItem(`${this.store}:frames`); } catch {}
    this.id = id || Math.random().toString(36).slice(2, 10);
    try { localStorage.setItem(`${this.store}:frames`, this.id); } catch {}
    this.n = 0;
    this.frame = null; // { path, width, height }: the last frame, in page (CSS) pixels
    this.state = "starting"; // starting | ready | error | gone
    this.error = null;
    this.loading = false;
    this.nav = { back: false, forward: false };
    this.tabs = []; // this window's pages, in the order they appeared
    this.wins = new Map(); // target id -> Chromium window id
    this.target = null; // the tab on screen
    this.session = null; // its CDP session on the browser connection
    this.root = null; // the pane's size, logical pixels
    this.calls = new Map();
    this.seq = 0;
    this.gen = 0;
    this.moves = 0; // tab picks and activations, so a poll that started before one doesn't undo it
    this.note = null;
    this.mac = win()?.platform === "macos";
    this.handle = cx.focus_handle();
    this.address = InputState.new({ placeholder: "Type a URL, or a port for a dev server (3000)" });
    this.address.set_value(this.url === "about:blank" ? "" : this.url);
    this.address.on("submit", (_e, cx) => this.go(this.address.value(), cx));
    if (checking()) return;
    this.start(cx);
    cx.spawn(async () => {
      for (;;) if ((await nextCommand()) === "focus") (this.url === "about:blank" ? this.address : this.handle).focus();
    });
  }

  start(cx) {
    this.state = "starting";
    this.error = null;
    const gen = ++this.gen;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.connect(cx, gen); } catch (e) { if (gen === this.gen) { this.state = "error"; this.error = String(e?.message ?? e); } }
      cx.notify();
    });
  }

  async connect(cx, gen) {
    // Written by install.mjs: where Node and browser.mjs are.
    const config = JSON.parse((await readTextFile(`${home()}/.herdr-browser/config.json`).catch(() => null)) ?? "null");
    if (!config?.node) throw new Error("herdr-browser isn't installed: run node install.mjs in its folder");
    const r = await exec(config.node, [`${config.root}/browser.mjs`], { timeout: 20_000 });
    const out = JSON.parse(r.stdout || "{}");
    if (!out.ok) throw new Error(out.error || r.stderr.trim() || "browser.mjs didn't answer");
    this.port = out.port;
    const version = await (await fetch(`http://127.0.0.1:${out.port}/json/version`)).json();
    this.ws = await WebSocket.connect(version.webSocketDebuggerUrl);
    await fs.mkdir(`${appHome()}/${DIR}`, { recursive: true });
    await this.dropFrames(); // a reload skips close() and restarts the frame count
    const ws = this.ws;
    cx.spawn(async (cx) => this.pump(cx, ws));
    // Reattach to this pane's window when its tab is still open: herdr reloads a mod without calling close(), and a
    // restored layout should come back to the same tabs, not leave them running unseen.
    let mine = null;
    try { mine = localStorage.getItem(`${this.store}:target`); } catch {}
    const pages = await this.list();
    const target = pages.find((p) => p.id === mine)?.id ?? (await this.send("Target.createTarget", { url: this.url, newWindow: true }))?.targetId;
    if (!target) throw new Error("Chromium didn't open a page");
    this.window = await this.windowOf(target);
    this.state = "ready";
    await this.show(target, cx);
    await this.tick(cx);
    cx.spawn(async (cx) => {
      while (gen === this.gen && this.state === "ready") { await cx.sleep(POLL); if (gen === this.gen) await this.tick(cx); }
    });
  }

  send(method, params = {}, sessionId) {
    if (!this.ws) return Promise.resolve(null);
    const id = ++this.seq;
    return new Promise((resolve) => {
      this.calls.set(id, resolve);
      this.ws.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })).catch(() => resolve(null));
    });
  }

  async list() {
    const all = await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json();
    return all.filter((t) => t.type === "page");
  }

  async windowOf(target) {
    if (!this.wins.has(target)) this.wins.set(target, (await this.send("Browser.getWindowForTarget", { targetId: target }))?.windowId ?? null);
    return this.wins.get(target);
  }

  // The strip follows this window's pages; the front one (most recently activated, by you or an agent) is on screen.
  async tick(cx) {
    if (this.closing) return;
    const moves = this.moves;
    let pages;
    try { pages = await this.list(); } catch { return; } // the browser's gone: pump says so
    for (const p of pages) await this.windowOf(p.id);
    const before = this.tabs.length > 1;
    const s = strip(this.tabs, pages.filter((p) => this.wins.get(p.id) === this.window));
    this.tabs = s.tabs;
    // A list fetched before you picked a tab predates that pick: it only updates the strip.
    if (moves === this.moves) {
      if (!s.front) { this.detach(); await this.newTab(cx); return; } // the last tab closed: a pane always has one
      if (s.front !== this.target) await this.show(s.front, cx);
    }
    if (before !== this.tabs.length > 1) this.resize();
    cx.notify();
  }

  detach() {
    if (this.session) {
      this.send("Page.stopScreencast", {}, this.session);
      this.send("Target.detachFromTarget", { sessionId: this.session });
    }
    this.session = null;
    this.target = null;
    this.frame = this.mid = this.base = null;
    this.loading = false;
  }

  async show(target, cx) {
    this.detach();
    this.target = target;
    try { localStorage.setItem(`${this.store}:target`, target); } catch {}
    const info = (await this.send("Target.getTargetInfo", { targetId: target }))?.targetInfo;
    this.setUrl(info?.url ?? "about:blank");
    const s = (await this.send("Target.attachToTarget", { targetId: target, flatten: true }))?.sessionId;
    if (target !== this.target) { if (s) this.send("Target.detachFromTarget", { sessionId: s }); return; } // switched again meanwhile
    this.session = s;
    await this.send("Page.enable", {}, s);
    await this.resize();
    await this.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: 3840, maxHeight: 2400 }, s);
    this.history(cx);
    cx.notify();
  }

  activate(target) {
    this.moves++;
    return fetch(`http://127.0.0.1:${this.port}/json/activate/${target}`).catch(() => {});
  }

  async pick(target, cx) {
    await this.activate(target);
    await this.show(target, cx);
  }

  async newTab(cx) {
    if (this.state !== "ready" || this.opening) return;
    this.opening = true;
    try { await this.openTab(cx); } finally { this.opening = false; }
  }

  async openTab(cx) {
    const r = (await this.send("Target.createTarget", { url: "about:blank", windowId: this.window }))
      ?? (await this.send("Target.createTarget", { url: "about:blank", newWindow: true })); // the window closed with its last tab
    if (!r?.targetId) return;
    this.window = await this.windowOf(r.targetId);
    await this.activate(r.targetId);
    await this.show(r.targetId, cx);
    await this.tick(cx);
    this.address.focus();
  }

  async closeTab(target, cx) {
    await this.send("Target.closeTarget", { targetId: target });
    await this.tick(cx);
  }

  async pump(cx, ws) {
    for (;;) {
      let msg;
      try { msg = JSON.parse(await ws.read()); } catch {
        if (this.closing || ws !== this.ws) return;
        this.ws = null;
        this.session = null;
        this.state = "gone";
        this.gen++;
        cx.notify();
        return;
      }
      if (msg.id) { this.calls.get(msg.id)?.(msg.result ?? null); this.calls.delete(msg.id); continue; }
      if (!msg.sessionId || msg.sessionId !== this.session) continue;
      const p = msg.params ?? {};
      if (msg.method === "Page.screencastFrame") {
        const { deviceWidth: w, deviceHeight: h } = p.metadata;
        if (p.data === this.lastData) { this.send("Page.screencastFrameAck", { sessionId: p.sessionId }, msg.sessionId); continue; }
        this.lastData = p.data;
        // A new name per frame: rewriting a shown file raced herdr's reload (it read it half-written and kept a blank).
        const n = this.n++;
        const path = `${DIR}/${this.id}-${n}.svg`;
        const old = `${DIR}/${this.id}-${n - KEEP}.svg`;
        if (old !== this.base?.path && old !== this.mid?.path) fs.unlink(`${appHome()}/${old}`).catch(() => {}); // dropFrames gets a kept one
        // The SVG declares half the frame's size: herdr keeps decoded images under a memory budget and evicts the oldest,
        // and at full size the frames on screen were evicted (the pane went blank for a second at a time). It still
        // rasterizes at the drawn size, so the page stays sharp.
        await fs.writeFile(`${appHome()}/${path}`, `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w / 2}" height="${h / 2}" viewBox="0 0 ${w} ${h}"><image width="${w}" height="${h}" preserveAspectRatio="none" xlink:href="data:image/jpeg;base64,${p.data}"/></svg>`).catch(() => {});
        // Chromium sends the next frame only after this ack. Holding it to GAP caps a busy page at a few new images a
        // second (it sent 13), which keeps fewer of them in herdr's image budget and saves CPU.
        const ack = msg.sessionId;
        const wait = Math.max(0, (this.lastAck ?? 0) + GAP - Date.now());
        this.lastAck = Date.now() + wait;
        cx.timer.after(wait, () => { if (ack === this.session) this.send("Page.screencastFrameAck", { sessionId: p.sessionId }, ack); });
        if (msg.sessionId !== this.session) continue; // switched tabs while writing
        this.present({ path, width: w, height: h }, cx);
      } else if ((msg.method === "Page.frameNavigated" && !p.frame.parentId) || msg.method === "Page.navigatedWithinDocument") {
        this.setUrl(p.frame?.url ?? p.url);
        this.history(cx);
        cx.notify();
      } else if (msg.method === "Page.frameStartedLoading" && p.frameId === this.target) {
        this.loading = true;
        cx.notify();
      } else if (msg.method === "Page.frameStoppedLoading" && p.frameId === this.target) {
        this.loading = false;
        cx.notify();
      }
    }
  }

  // herdr loads an image after it's first drawn, and shows nothing meanwhile (a big frame takes hundreds of ms). So
  // three frames are stacked: `base`, drawn without a break for at least SETTLE ms, so loaded; `mid`, loading towards
  // that; and the newest on top. On a busy page the top may never finish loading before the next frame, but the
  // layers under it always show something.
  present(f, cx) {
    const now = Date.now();
    this.frame = f;
    if (!this.mid) this.mid = { ...f, at: now };
    else if (now - this.mid.at >= SETTLE) { this.base = this.mid; this.mid = { ...f, at: now }; }
    cx.notify();
  }

  setUrl(url) {
    this.url = url;
    this.address.set_value(url === "about:blank" ? "" : url);
  }

  history(cx) {
    const s = this.session;
    cx.spawn(async (cx) => {
      const h = await this.send("Page.getNavigationHistory", {}, s);
      if (!h || s !== this.session) return;
      this.entries = h.entries;
      this.at = h.currentIndex;
      this.nav = { back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1 };
      cx.notify();
    });
  }

  step(by) {
    const e = this.entries?.[this.at + by];
    if (e) this.send("Page.navigateToHistoryEntry", { entryId: e.id }, this.session);
  }

  go(text, cx) {
    const url = toUrl(text);
    if (!url) return;
    this.handle.focus();
    if (this.state !== "ready") { this.url = url; return this.start(cx); }
    if (!this.session) return this.send("Target.createTarget", { url, windowId: this.window }).then(() => this.tick(cx));
    this.send("Page.navigate", { url }, this.session);
  }

  // The page's viewport: the pane minus the toolbar, the loading line and the strip when it shows.
  size() {
    if (!this.root) return null;
    return { width: this.root.width, height: Math.max(1, this.root.height - BAR - 2 - (this.tabs.length > 1 ? TABS : 0)) };
  }

  async resize() {
    const size = this.size();
    if (!size || !this.session) return;
    const width = Math.max(1, Math.round(size.width)), height = Math.max(1, Math.round(size.height));
    const key = `${this.session} ${width}x${height}`;
    if (key === this.sized) return; // an override repaints the page, and a repaint is a frame: only on a real change
    this.sized = key;
    await this.send("Emulation.setDeviceMetricsOverride", {
      width, height,
      deviceScaleFactor: this.mac ? 2 : 1, mobile: false, // ponytail: herdr doesn't expose the display scale
    }, this.session);
  }

  box() { return fit(this.size(), this.frame); }

  mouse(type, e, extra = {}) {
    const at = toPage(e.local_position, this.box());
    if (!at || !this.session) return;
    const modifiers = (e.modifiers?.alt ? 1 : 0) | (e.modifiers?.control ? 2 : 0) | (e.modifiers?.platform ? 4 : 0) | (e.modifiers?.shift ? 8 : 0);
    return this.send("Input.dispatchMouseEvent", { type, ...at, modifiers, ...extra }, this.session);
  }

  move(e) {
    if (this.moving) return; // one in flight: a fast pointer would queue more moves than the page can take
    this.moving = true;
    const buttons = this.pressed ? { button: this.pressed, buttons: this.pressed === "left" ? 1 : 2 } : {};
    Promise.resolve(this.mouse("mouseMoved", e, buttons)).finally(() => { this.moving = false; });
  }

  // Clicking into the page makes this pane's window the one agents open new tabs in.
  press(button, e) {
    this.handle.focus();
    if (this.target) this.activate(this.target);
    if (button === "left") this.pressed = "left";
    this.mouse("mousePressed", e, { button, clickCount: button === "left" ? e.click_count : 1 });
  }

  key(e, cx) {
    const m = e.modifiers ?? {};
    const primary = this.mac ? m.platform : m.control;
    const key = String(e.key ?? "").toLowerCase();
    if (primary && !m.shift && !m.alt && (key === "t" || key === "w" || key === "tab")) {
      cx.stop_propagation();
      if (key === "t") this.newTab(cx);
      else if (key === "w" && this.target && this.tabs.length > 1) this.closeTab(this.target, cx);
      else if (key === "tab" && this.tabs.length > 1) {
        const i = this.tabs.findIndex((t) => t.id === this.target);
        this.pick(this.tabs[(i + 1) % this.tabs.length].id, cx);
      }
      return;
    }
    const k = keyToCdp(e, this.mac);
    if (!k || !this.session) return;
    cx.stop_propagation();
    const s = this.session;
    if (k.paste) {
      const text = cx.read_from_clipboard();
      if (text) this.send("Input.insertText", { text }, s);
    } else if (k.copy || k.cut) {
      cx.spawn(async (cx) => {
        const r = await this.send("Runtime.evaluate", { expression: "String(getSelection()) || (document.activeElement?.value ?? '').slice(document.activeElement.selectionStart, document.activeElement.selectionEnd)", returnByValue: true }, s);
        const text = r?.result?.value;
        if (text) cx.write_to_clipboard(text);
        if (k.cut) this.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 }, s);
      });
    } else for (const ev of k.send) this.send("Input.dispatchKeyEvent", ev, s);
  }

  async close() {
    this.closing = true;
    if (this.port) for (const t of this.tabs) await fetch(`http://127.0.0.1:${this.port}/json/close/${t.id}`).catch(() => {});
    await this.dropFrames();
  }

  async dropFrames() {
    for (const f of await fs.readdir(`${appHome()}/${DIR}`).catch(() => [])) if (f.startsWith(`${this.id}-`)) await fs.unlink(`${appHome()}/${DIR}/${f}`).catch(() => {});
  }

  render() {
    const t = theme();
    const tool = (id, icon, on, enabled = true) => div().id(id).flex_none().size(24).flex().items_center().justify_center().rounded(4)
      .text_color(enabled ? t.dim : t.border)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { cx.stop_propagation(); on(cx); }))
      .child(svg(`${ICON}/${icon}.svg`).size(14));

    const center = (text, color, action) => v_flex().size_full().items_center().justify_center().gap(10).p(24)
      .child(div().max_w(460).text_size(13).text_color(color).text_center().child(text))
      .when(Boolean(action), (el) => el.child(div().id("kb-act").px(10).h(26).flex().items_center().rounded(4).border_1().border_color(t.border)
        .text_size(12).text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => action[1](cx)).child(action[0])));

    const box = this.box();
    const ready = this.state === "ready";
    const body = this.state === "error" ? center(`Couldn't start the browser: ${this.error}`, t.blocked, ["Retry", (cx) => this.start(cx)])
      : this.state === "gone" ? center("The browser closed.", t.dim, ["Reopen", (cx) => this.start(cx)])
      : this.state === "starting" ? center("Starting the browser…", t.dim)
      : this.url === "about:blank" ? center(`Type a URL above, or just a dev server's port: 3000 opens localhost:3000. Agents can open and drive tabs here too, over CDP on port ${this.port}.`, t.dim)
      : !this.frame || !box ? center("Loading…", t.dim)
      : div().relative().w(box.width).h(box.height)
        .children([this.base, this.mid, this.frame].filter((f, i, all) => f && f.path !== all[i + 1]?.path)
          .map((f) => image(f.path).id(f.path).absolute().inset_0().size_full())); // a frame keeps its loaded image as it moves down

    const label = (tab) => tab.title && tab.title !== tab.url ? tab.title : tab.url === "about:blank" ? "New tab" : tab.url.replace(/^https?:\/\/(www\.)?/, "");
    const tabStrip = h_flex().flex_none().h(TABS).px(4).gap(2).items_end().bg(t.surface ?? t.background).border_b_1().border_color(t.border)
      .children(this.tabs.map((tab, i) => {
        const on = tab.id === this.target;
        return h_flex().id(`kb-tab-${i}`).flex_1().min_w(0).max_w(220).h(24).pl(10).pr(3).gap(4).items_center().rounded_t(4)
          .text_size(12).text_color(on ? t.foreground : t.dim).cursor_pointer()
          .when(on, (el) => el.bg(t.background).border_1().border_b_0().border_color(t.border))
          .when(!on, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
          .on_click((_e, cx) => this.pick(tab.id, cx))
          .child(div().flex_1().min_w(0).truncate().child(label(tab)))
          .child(div().id(`kb-tabx-${i}`).flex_none().size(18).flex().items_center().justify_center().rounded(3)
            .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.closeTab(tab.id, cx); })
            .child(svg(`${ICON}/x.svg`).size(12)));
      }));

    return v_flex().id("root").size_full().bg(t.background).text_size(13)
      .on_size_change((size, cx) => {
        this.root = { width: size.width, height: size.height };
        this.resize();
        cx.notify();
      })
      .when(ready && this.tabs.length > 1, (el) => el.child(tabStrip))
      .child(h_flex().flex_none().h(BAR).px(6).gap(2).items_center().border_b_1().border_color(t.border).bg(t.surface ?? t.background)
        .child(tool("kb-back", "back", () => this.step(-1), this.nav.back && !!this.session))
        .child(tool("kb-fwd", "forward", () => this.step(1), this.nav.forward && !!this.session))
        .child(this.loading ? tool("kb-stop", "stop", () => this.send("Page.stopLoading", {}, this.session))
          : tool("kb-reload", "reload", (cx) => (ready ? this.send("Page.reload", {}, this.session) : this.start(cx))))
        .child(h_flex().flex_1().min_w(0).h(24).mx(4).px(8).items_center().rounded(4).bg(t.background).border_1().border_color(t.border)
          .child(Input.new(this.address).flex_1().h_full().text_size(12.5)))
        .child(tool("kb-new", "plus", (cx) => this.newTab(cx), ready))
        .child(div().id("kb-cdp").flex_none().px(6).h(22).flex().items_center().rounded(4).text_size(11).text_color(t.dim)
          .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => {
            if (!this.port) return;
            cx.write_to_clipboard(`http://127.0.0.1:${this.port}`);
            this.note = "copied";
            cx.notify();
            cx.timer.after(1500, (cx) => { this.note = null; cx.notify(); });
          })
          .child(this.note === "copied" ? "Copied" : ready ? `CDP ${this.port}` : ""))
        .child(tool("kb-ext", "external", (cx) => cx.open_url(this.url), /^https?:/.test(this.url))))
      .child(div().flex_none().h(2).when(this.loading, (el) => el.bg(t.accent)))
      .child(div().id("kb-view").flex_1().min_h(0).overflow_hidden().track_focus(this.handle)
        .on_mouse_down("left", (e) => this.press("left", e))
        .on_mouse_up("left", (e) => { this.pressed = null; this.mouse("mouseReleased", e, { button: "left", clickCount: e.click_count }); })
        .on_mouse_down("right", (e) => this.press("right", e))
        .on_mouse_up("right", (e) => this.mouse("mouseReleased", e, { button: "right", clickCount: 1 }))
        .on_mouse_move((e) => this.move(e))
        .on_scroll_wheel((e) => this.mouse("mouseWheel", e, { deltaX: -e.delta.x, deltaY: -e.delta.y }))
        .on_key_down((e, cx) => this.key(e, cx))
        .child(body));
  }
}
