// Past sessions: every Claude Code conversation on this computer (feed/kodr-sessions.mjs), newest
// first, the shown space's folder on top. Type to filter, ↑/↓ and Enter to reopen it with
// `claude --resume` in a new tab (in the space for its folder, or a new space), Esc to leave.
// One that's already open in a tab goes there instead. Opened with Ctrl+Shift+H (mod.open:kodr-sessions).
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, terminals, run, exec, theme, props, closeOverlay, home, readTextFile } from "herdr";

const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const base = (p) => (p ?? "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const ago = (at) => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`;
};

export default class Sessions extends View {
  init(_props, cx) {
    this.list = null; // null while reading
    this.error = null;
    this.open = new Map(); // session id → live terminal address
    this.at = 0;
    this.filter = "";
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Find a past session by title, message or folder…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.go(this.picks()[this.at], cx));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    cx.spawn(async (cx) => {
      const kodr = `${home()}/.kodr-herdr`;
      try {
        this.config = JSON.parse(await readTextFile(`${kodr}/config.json`));
        const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-sessions.mjs`], { timeout: 20_000 });
        const out = JSON.parse(r.stdout || "{}");
        if (out.error || !out.sessions) throw new Error(out.error || r.stderr.trim() || "No answer from the session list");
        // Which are open now: Kodr records the session each terminal runs.
        for (const x of terminals().filter((x) => x.state === "live")) {
          const s = JSON.parse((await readTextFile(`${kodr}/t/${x.address}/session.json`).catch(() => null)) ?? "null");
          if (s?.session) this.open.set(s.session, x.address);
        }
        this.list = out.sessions;
      } catch (e) {
        this.error = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  // Rows in order: { head } or { s } (a session). "Here" = the shown space's folder (not home).
  rows() {
    const f = this.filter.toLowerCase().trim();
    const all = (this.list ?? []).filter((s) => !f || `${s.title} ${s.first} ${s.cwd}`.toLowerCase().includes(f));
    const space = spaces().find((w) => w.active && !w.machine);
    const here = space && norm(space.folder) && norm(space.folder) !== norm(home()) ? norm(space.folder) : null;
    const mine = here ? all.filter((s) => norm(s.cwd) === here || norm(s.cwd).startsWith(here + "/")) : [];
    const rest = all.filter((s) => !mine.includes(s));
    const out = [];
    if (mine.length) out.push({ head: `In ${space.name}` }, ...mine.map((s) => ({ s })));
    if (rest.length) {
      if (mine.length) out.push({ head: "Everywhere else" });
      out.push(...rest.map((s) => ({ s })));
    }
    return out;
  }

  picks() { return this.rows().filter((r) => r.s && !r.s.gone); }

  go(r, _cx) {
    const s = r?.s ?? r;
    if (!s?.id || s.gone || !this.config) return;
    this.close();
    const t = this.open.get(s.id);
    if (t) return run("agent.focus", { terminal: t });
    const argv = [...this.config.launch, "--resume", s.id];
    const name = s.title.length > 28 ? `${s.title.slice(0, 27)}…` : s.title;
    const space = spaces().find((w) => !w.machine && norm(w.folder) === norm(s.cwd));
    if (space) run("tab.new", { name, space: space.id, folder: s.cwd, argv });
    else run("space.new", { name: base(s.cwd), folder: s.cwd, argv });
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const picks = rows.filter((r) => r.s && !r.s.gone);
    this.at = Math.max(0, Math.min(this.at, picks.length - 1));
    const sel = picks[this.at];
    const message = this.error ? `Couldn't read your sessions: ${this.error}`
      : !this.list ? "Reading sessions…"
      : !this.list.length ? "No Claude sessions on this computer yet."
      : !rows.length ? `Nothing matches “${this.filter.trim()}”.` : null;

    const row = (r, i) => {
      if (r.head) return div().id(`sh${i}`).px(10).pt(i ? 12 : 4).pb(4).text_size(11).font_semibold().text_color(t.dim).child(r.head);
      const s = r.s, on = r === sel, live = this.open.has(s.id);
      return h_flex().id(`s${i}`).mx(4).px(10).py(6).gap(10).items_center().rounded(4)
        .when(!s.gone, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover)).on_click((_e, cx) => this.go(r, cx)))
        .when(on, (el) => el.bg(t.selected))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(13).text_color(s.gone ? t.dim : t.foreground).child(s.title))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(s.first === s.title ? base(s.cwd) : `${base(s.cwd)} · ${s.first}`)))
        .when(live, (el) => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(3).border_1().border_color(t.border).text_size(11).text_color(t.done).child("open")))
        .when(s.gone, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("folder gone")))
        .child(div().flex_none().w(28).text_size(11.5).text_color(t.dim).text_right().child(ago(s.at)));
    };

    return v_flex().id("sessions").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return this.close();
        if (!picks.length) return;
        if (e.key === "down") this.at = (this.at + 1) % picks.length;
        else if (e.key === "up") this.at = (this.at + picks.length - 1) % picks.length;
        else return;
        this.scroll.scroll_to_item(rows.indexOf(picks[this.at]));
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Past sessions"))
        .child(div().id("s-esc").px(6).py(2).rounded(4).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(4).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(14).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(message
        ? div().px(10).py(8).text_size(12.5).text_color(this.error ? t.blocked : t.dim).child(message)
        : v_flex().id("s-list").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.scroll).children(rows.map(row)))
      .when(Boolean(sel), (el) => el.child(div().text_size(11).text_color(t.dim)
        .child(this.open.has(sel.s.id) ? "Enter goes to its tab"
          : Date.now() - sel.s.at < 120_000 ? `Written to ${ago(sel.s.at) === "now" ? "just now" : `${ago(sel.s.at)} ago`}: if it's still open somewhere else, two Claudes would share it`
          : `Enter reopens it in ${base(sel.s.cwd)} with claude --resume`)));
  }
}
