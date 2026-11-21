// Kodr's pane header: herdr's own (icon, name, folder, status, split/zoom/close), plus a
// Terminal | Chat switch on Claude terminals started with Kodr's settings. Chat opens beside the
// terminal, zoomed over it; the terminal keeps its pane (parking would drop the agent from herdr's
// Agents list and its "Needs you"). Terminal closes the chat. A chat's × does the same.
// Props from the app: { pane, terminal }. Command: "kodr-pane.toggle" switches the focused pane.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, agents, props, run, theme, home, exec, hc, readTextFile, notify, nextCommand, setShared, shared } from "herdr";
import { attention, allowed, canChat, titleOf } from "./attention.js";

const CHAT = "kodr-chat";
const LABEL = "kodr.chat";
const kodrHome = () => `${home()}/.kodr-herdr`;
let lastSwap = 0; // shared by every header copy: one swap at a time
const seen = new Map(); // agent statuses, for desktop notifications (one watcher for all copies)
let lastWatch = 0;
let lastMission = 0;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") || cwd.startsWith(h + "\\") ? "~" + cwd.slice(h.length) : cwd;
}

// Any Claude Code pane can switch: one not started with Kodr's settings is attached on the way.

// The live agent terminal a chat pane shows (labelled when the chat opened).
const agentOf = (chatPane) => terminals().find((x) => x.labels?.[LABEL] === chatPane && x.state === "live") ?? null;

export default class KodrPane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.busy = false;
    this.kodr = null; // does this terminal run a Kodr session? (its session.json exists)
    this.born = Date.now();
    cx.spawn(async (cx) => {
      this.config = JSON.parse((await readTextFile(`${kodrHome()}/config.json`).catch(() => null)) ?? "null");
      cx.notify();
    });
    this.check(cx);
    cx.timer.every(3000, (cx) => this.check(cx));
    cx.timer.every(1000, () => this.watch());
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        const p = this.me();
        // "kodr-pane.review": the Review tab (opened if needed), on the focused pane's session.
        if (c === "review" && p?.focused) {
          const t = p.mod === CHAT ? agentOf(p.pane)?.address : p.terminal;
          if (t) setShared("kodr.review.select", { terminal: t, at: Date.now() });
          const tab = panes().find((x) => x.mod === "kodr-review")?.tab;
          if (tab) run("tab.select", { id: tab });
          else run("tab.new", { name: "Review", mod: "kodr-review" });
          continue;
        }
        // "kodr-pane.mission": Mission in the side panel. Every header copy gets the key: one acts.
        if (c === "mission") {
          if (Date.now() - lastMission < 1000) continue;
          lastMission = Date.now();
          run("layout.select", { stack: "panel-body", child: "mission" });
          run("layout.show", { id: "panel" });
          continue;
        }
        // A copy that just appeared (the swap's new pane) mustn't swap straight back.
        if (c !== "toggle" || !p?.focused || Date.now() - this.born < 1500 || Date.now() - lastSwap < 1500) continue;
        if (p.mod === CHAT) this.toTerminal(p.pane, cx);
        else if (canChat(p, this.ended)) this.toChat(p, cx);
      }
    });
  }

  // A Windows notification when an agent needs the person or finished unseen. Herdr's own toast skips
  // the focused tab even when its window is behind another app; kodr-notify.ps1 skips it only when
  // Herdr is the window in front. Off with "Desktop notifications" in the chat's Ctrl+Shift+M menu; per space
  // (All / Needs me / Off) in the same menu, kept in shared "kodr.notify.spaces" {space id: level}.
  watch() {
    if (Date.now() - lastWatch < 800) return; // every header copy ticks; one of them acts
    lastWatch = Date.now();
    const news = allowed(attention(seen, agents()), shared("kodr.notify.spaces") ?? {});
    const c = this.config;
    if (!news.length || !(shared("kodr.notify.desktop") ?? true) || !c?.herdrApp?.toLowerCase().endsWith(".exe")) return;
    for (const { agent: a, kind } of news) {
      const title = `${a.tab_name || a.title || "Claude"} ${kind === "blocked" ? "needs you" : "is done"}`;
      exec("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `${c.root}/feed/kodr-notify.ps1`,
        "-Title", title, "-Body", [a.title, a.space_name].filter((x) => x && x !== "~").join(" · "), "-App", c.herdrApp.replace(/\//g, "\\")], { timeout: 10_000 }).catch(() => {});
    }
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  check(cx) {
    const t = this.me()?.terminal;
    if (!t) return;
    cx.spawn(async (cx) => {
      const s = await readTextFile(`${kodrHome()}/t/${t}/session.json`).catch(() => null);
      let ended = false;
      try { ended = Boolean(JSON.parse(s ?? "{}").ended); } catch {}
      const kodr = Boolean(s);
      if (kodr !== this.kodr || ended !== this.ended) { this.kodr = kodr; this.ended = ended; cx.notify(); }
    });
  }

  // One app command, waited for: the swap's steps must happen in order.
  async app(name, args) {
    const r = await exec(this.config?.herdrApp ?? "herdr-app", ["do", name, JSON.stringify(args)]);
    let out = {};
    try { out = JSON.parse(r.stdout || "{}"); } catch {}
    if (r.code !== 0 || out.error) throw new Error(out.error || r.stderr.trim() || `${name} failed`);
    return out;
  }

  swap(cx, title, steps) {
    if (this.busy) return;
    this.busy = true;
    lastSwap = Date.now();
    cx.notify();
    cx.spawn(async (cx) => {
      try { await steps(); } catch (e) { notify({ title, body: String(e?.message ?? e), level: "error" }); }
      this.busy = false;
      cx.notify();
    });
  }

  // Terminal → Chat: the chat opens beside, then the terminal is parked so the chat has its spot.
  toChat(p, cx) {
    // The layout can be installed without Kodr's Node side (from herdr.dev): say so instead of failing.
    if (!this.config) return notify({ title: "Chat needs Kodr's tools", body: "Kodr's tools aren't installed: clone github.com/noxire-dev/kodr-herdr and run node bin/install.mjs.", level: "error" });
    const terminal = p.terminal;
    const open = terminals().find((x) => x.address === terminal)?.labels?.[LABEL];
    if (open && panes().some((x) => x.pane === open)) { run("pane.focus", { pane: open }); return; }
    const attach = !this.kodr;
    this.swap(cx, "Chat didn't open", async () => {
      // A Claude started outside Kodr: find its session first (chat only, no permission cards).
      if (attach) {
        const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-attach.mjs`, terminal]);
        let res = {};
        try { res = JSON.parse(r.stdout); } catch {}
        if (!res.ok) throw new Error(res.error ?? "Couldn't find this terminal's Claude session");
        this.kodr = true;
      }
      if (p.zoomed) await this.app("pane.zoom", { pane: p.pane });
      const out = await this.app("pane.split", { direction: "right", pane: p.pane, mod: CHAT, props: { terminal } });
      if (!out.pane) throw new Error("herdr didn't open the chat pane");
      await hc(["label", terminal, `${LABEL}=${out.pane}`]);
      await this.app("pane.focus", { pane: out.pane });
      await this.app("pane.zoom", { pane: out.pane });
    });
  }

  // Chat → Terminal: the chat closes. A terminal parked some other way gets its pane back first.
  toTerminal(chatPane, cx) {
    const agent = agentOf(chatPane);
    const own = agent && panes().find((x) => x.terminal === agent.address);
    if (!agent || own) {
      run("pane.close", { pane: chatPane });
      if (agent) hc(["label", agent.address, `${LABEL}=`]);
      if (own) run("pane.focus", { pane: own.pane });
      return;
    }
    this.swap(cx, "Terminal didn't come back", async () => {
      await this.app("pane.focus", { pane: chatPane });
      const out = await this.app("terminal.keep", { terminal: agent.address, place: "right" });
      await hc(["label", agent.address, `${LABEL}=`]);
      if (out.pane) run("pane.focus", { pane: out.pane });
      await this.app("pane.close", { pane: chatPane });
    });
  }

  button(t, id, name, onClick) {
    return div().id(id).p(3).rounded(3).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); onClick(cx); })
      .child(svg(`mods/kodr-pane/${name}.svg`).size(14));
  }

  // Terminal | Chat, always visible: the current view is filled, the other is a target.
  switcher(t, pane, chat, onSwitch) {
    const seg = (id, label, on) => div().id(id).px(8).h(20).flex().items_center().text_size(11.5)
      .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground)))
      .when(!on && !this.busy, (el) => el.on_click((_e, cx) => { cx.stop_propagation(); onSwitch(cx); }))
      .child(label);
    return h_flex().flex_none().rounded(3).border_1().border_color(t.border).overflow_hidden()
      .child(seg(`kp-t-${pane}`, "Terminal", !chat))
      .child(seg(`kp-c-${pane}`, "Chat", chat));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const chat = p.mod === CHAT;
    const agent = chat ? agentOf(p.pane) : null;
    const prog = agent?.program ?? p.program;
    const name = chat && !agent ? "Chat" : p.mod === "kodr-review" ? "Review" : ((prog?.agent || prog?.shell) && prog.name) || titleOf(agent?.title ?? p.title) || prog?.name || "shell";
    const st = agent ? (["working", "blocked", "done", "idle"].includes(agent.status) ? agent.status : null) : p.status;
    const cwd = agent ? (agent.foreground?.cwd ?? agent.cwd) : p.cwd;
    const pic = icon(prog, 14, t.dim);
    const pane = p.pane;
    const swappable = chat ? Boolean(agent) : canChat(p, this.ended); // a chat with no live terminal, or a pane whose Claude ended, has nothing to switch to
    return h_flex().id(`kp-head-${pane}`).size_full().px(10).gap(8).items_center()
      .bg(t.chrome).border_b(1).border_color(t.border).text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      // Left, next to the name: the hover buttons on the right never push it around.
      .when(swappable, (el) => el.child(this.switcher(t, pane, chat, (cx) => (chat ? this.toTerminal(pane, cx) : this.toChat(p, cx)))))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(cwd)))
      .when(st === "working", (el) => el.child(svg("mods/kodr-pane/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(3).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", (el) => el.child(div().size(6).flex_none().rounded(1).bg(t.done)))
      .when(this.hovered, (el) => el
        .child(this.button(t, `kp-r-${pane}`, "split-right", () => run("pane.split", { direction: "right", pane })))
        .child(this.button(t, `kp-d-${pane}`, "split-down", () => run("pane.split", { direction: "down", pane })))
        .child(this.button(t, `kp-z-${pane}`, p.zoomed ? "unzoom" : "zoom", () => run("pane.zoom", { pane })))
        .child(this.button(t, `kp-x-${pane}`, "close", (cx) => (chat ? this.toTerminal(pane, cx) : run("pane.close", { pane })))));
  }
}
