// Preview: the dev servers running in herdr's terminals (feed/kodr-ports.mjs), this space's first.
// Enter opens one in a Browser pane (herdr-browser, browser/) beside the focused pane, a page agents can drive over CDP;
// Deft opens it in the browser the agent drives through Deft's tools (only when Deft is installed); Ctrl+Enter
// (or Browser) opens it in the default browser. ↑/↓ pick,
// Esc leaves. Rescans every 4 s while open. Opened with Ctrl+Shift+U (mod.open:kodr-preview).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, exec, theme, props, closeOverlay, home, readTextFile, checking, run } from "herdr";

export default class Preview extends View {
  init(_props, cx) {
    this.list = null; // null until the first scan answers
    this.error = null; // the scan failed
    this.note = null; // { text, bad }: what happened to the last open
    this.opening = null; // the port being handed to Deft
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(300, () => this.handle.focus());
    this.scan(cx);
    cx.timer.every(4000, (cx) => this.scan(cx));
  }

  async feed(args) {
    this.config ??= JSON.parse(await readTextFile(`${home()}/.kodr-herdr/config.json`));
    const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-ports.mjs`, ...args], { timeout: 25_000 });
    const out = JSON.parse(r.stdout || "{}");
    if (!r.stdout) throw new Error(r.stderr.trim() || "no answer from kodr-ports");
    return out;
  }

  scan(cx) {
    if (this.scanning || checking()) return;
    this.scanning = true;
    cx.spawn(async (cx) => {
      try {
        const out = await this.feed([]);
        if (out.error) throw new Error(out.error);
        this.list = out.servers;
        this.deft = out.deft !== false;
        this.error = null;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      this.scanning = false;
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  rows() {
    const space = spaces().find((w) => w.active);
    const all = this.list ?? [];
    const mine = all.filter((s) => s.space === space?.id);
    const rest = all.filter((s) => !mine.includes(s));
    const out = [];
    if (mine.length) out.push({ head: `In ${space.name}` }, ...mine.map((s) => ({ s })));
    if (rest.length) out.push({ head: mine.length ? "Everywhere else" : "In other spaces" }, ...rest.map((s) => ({ s })));
    return out;
  }

  // how: "pane" (a Browser pane), "deft", or "browser" (the default browser).
  open(s, how, cx) {
    if (!s || this.opening) return;
    if (how === "browser") { cx.open_url(s.url); return this.close(); }
    if (how === "pane") { run("pane.split", { direction: "right", mod: "herdr-browser", props: { url: s.url, key: Date.now().toString(36) } }); return this.close(); }
    this.opening = s.port;
    this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let out;
      try { out = await this.feed(["--open", s.url]); } catch (e) { out = { error: String(e?.message ?? e) }; }
      this.opening = null;
      if (out.ok) return this.close();
      this.note = { text: `${out.error}. Ctrl+Enter opens it in your default browser.`, bad: true };
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const picks = rows.filter((r) => r.s);
    this.at = Math.max(0, Math.min(this.at, picks.length - 1));
    const sel = picks[this.at]?.s;
    const message = this.error && !this.list ? `Couldn't look for servers: ${this.error}`
      : !this.list ? "Looking for dev servers…"
      : !rows.length ? "No dev servers in your terminals. Start one (npm run dev, or ask the agent to) and it shows up here." : null;

    const button = (id, label, on) => div().id(id).flex_none().px(8).h(22).flex().items_center().rounded(4).border_1().border_color(t.border)
      .text_size(11.5).text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); on(cx); }).child(label);

    const row = (r, i) => {
      if (r.head) return div().id(`ph${i}`).px(10).pt(i ? 12 : 4).pb(4).text_size(11).font_semibold().text_color(t.dim).child(r.head);
      const s = r.s, on = s === sel, busy = this.opening === s.port;
      return h_flex().id(`p${s.port}`).mx(4).px(10).py(6).gap(10).items_center().rounded(4).cursor_pointer()
        .hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.open(s, "pane", cx))
        .when(on, (el) => el.bg(t.selected))
        .child(svg("mods/kodr-preview/globe.svg").size(14).flex_none().text_color(on ? t.accent : t.dim))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(13).text_color(t.foreground).child(s.title || `localhost:${s.port}`))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child([`:${s.port}`, s.command, s.where].filter(Boolean).join(" · "))))
        .child(busy ? div().flex_none().text_size(11.5).text_color(t.working).child("Opening in Deft…")
          : h_flex().flex_none().gap(6)
            .child(button(`pp${s.port}`, "Pane", (cx) => this.open(s, "pane", cx)))
            .when(this.deft !== false, (el) => el.child(button(`pd${s.port}`, "Deft", (cx) => this.open(s, "deft", cx))))
            .child(button(`pb${s.port}`, "Browser", (cx) => this.open(s, "browser", cx))));
    };

    return v_flex().id("preview").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return this.close();
        if (!picks.length) return;
        if (e.key === "enter") this.open(sel, e.modifiers?.control || e.modifiers?.platform ? "browser" : "pane", cx);
        else if (e.key === "down") this.at = (this.at + 1) % picks.length;
        else if (e.key === "up") this.at = (this.at + picks.length - 1) % picks.length;
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Preview"))
        .child(div().id("p-esc").px(6).py(2).rounded(4).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(message
        ? div().px(10).py(8).text_size(12.5).text_color(this.error ? t.blocked : t.dim).child(message)
        : v_flex().id("p-list").flex_1().min_h(0).overflow_y_scroll().children(rows.map(row)))
      .when(Boolean(this.note || sel), (el) => el.child(div().text_size(11).text_color(this.note?.bad ? t.blocked : t.dim)
        .child(this.note?.text ?? "Enter opens it in a pane beside this one, where agents can drive it too · Ctrl+Enter in your default browser")));
  }
}
