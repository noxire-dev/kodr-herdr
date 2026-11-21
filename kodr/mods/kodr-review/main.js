// Review queue for Kodr's Claude sessions: what needs a decision first, the change since you last
// reviewed it (or one turn of it), and the checks Kodr ran from the base commit (not the agent).
// Sets herdr's agent order to match, so agent.next walks the same queue.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, home, readTextFile, writeTextFile, exec, hc, run, setAgentOrder, theme, nextCommand, settings, shared } from "herdr";

const dirOf = (address) => `${home()}/.kodr-herdr/t/${address}`;
const icon = (name) => `mods/kodr-review/${name}.svg`;
const MAX_LINES = 3000;
const GRACE_MS = 20_000; // a turn that just ended often has a follow-up coming: don't call it ready yet

// Lower comes first. Checks that failed outrank a clean finish; reviewed work sinks.
function rank(a, v, now) {
  if (a.status === "blocked") return 0;
  if (v.latest?.checks === "fail") return 1;
  if (a.status === "working" || v.latest?.checks === "running") return 3;
  if (v.latest && v.latest.sha !== v.reviewed) return now - (v.latest.at ?? 0) < GRACE_MS ? 3 : 2;
  return 4;
}
const REASON = ["Needs you", "Checks failed", "To review", "Working", "Reviewed"];

const statLine = (stat) => (stat || "")
  .replace(/(\d+) files? changed/, (_m, n) => `${n} file${n === "1" ? "" : "s"}`)
  .replace(/, (\d+) insertions?\(\+\)/, " +$1").replace(/, (\d+) deletions?\(-\)/, " −$1");

export default class KodrReview extends View {
  init(_props, cx) {
    this.items = [];
    this.selected = null;
    this.turn = null; // a single turn's sha, or null for everything since the last review
    this.diff = null;
    this.diffKey = null;
    this.seenSelect = 0;
    this.reload(cx);
    cx.timer.every(2000, (cx) => this.reload(cx));
    // "kodr-review.next" and "kodr-review.reviewed", for keys.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "next") this.next(cx);
        if (c === "reviewed") this.markReviewed(cx);
        cx.notify();
      }
    });
  }

  reload(cx) {
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const items = [], now = Date.now();
        for (const a of agents()) {
          const d = dirOf(a.address);
          const session = await readTextFile(`${d}/session.json`).catch(() => null);
          if (!session) continue;
          let v;
          try { v = JSON.parse(session); } catch { continue; }
          try { v.turns = JSON.parse((await readTextFile(`${d}/turns.json`).catch(() => null)) ?? "{}").turns ?? []; } catch { v.turns = []; }
          v.latest = v.turns.at(-1) ?? null;
          v.reviewed = ((await readTextFile(`${d}/reviewed`).catch(() => null)) ?? "").trim() || null;
          items.push({ a, v, rank: rank(a, v, now) });
        }
        items.sort((x, y) => x.rank - y.rank || y.a.seq - x.a.seq);
        this.items = items;
        setAgentOrder(items.map((i) => i.a.address));
        // The chat's "Review →" asks for its session.
        const ask = shared("kodr.review.select");
        if (ask?.at > this.seenSelect) { this.seenSelect = ask.at; this.selected = ask.terminal; this.turn = null; }
        if (!this.current() && items.length) this.selected = items[0].a.address;
        this.loadDiff(cx);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  current() {
    return this.items.find((i) => i.a.address === this.selected);
  }

  select(address, cx) {
    this.selected = address;
    this.turn = null;
    this.loadDiff(cx);
    cx.notify();
  }

  // The turns not reviewed yet: after the reviewed checkpoint, or all of them.
  openTurns(v) {
    const k = v.reviewed ? v.turns.findIndex((x) => x.sha === v.reviewed) : -1;
    return v.turns.slice(k + 1);
  }

  // One turn: from the checkpoint before it. Everything: since the last review, else the base commit.
  range(v) {
    if (this.turn) {
      const k = v.turns.findIndex((x) => x.sha === this.turn);
      return [k > 0 ? v.turns[k - 1].sha : v.base ?? `${this.turn}^`, this.turn];
    }
    return [v.reviewed ?? v.base ?? `${v.latest.sha}^`, v.latest.sha];
  }

  loadDiff(cx) {
    const v = this.current()?.v;
    if (!v?.latest) { this.diff = null; this.diffKey = null; return; }
    const [from, to] = this.range(v);
    const key = `${v.cwd}:${from}..${to}`;
    if (key === this.diffKey) return;
    this.diffKey = key;
    this.diff = null;
    cx.spawn(async (cx) => {
      const [r, n] = await Promise.all([
        exec("git", ["diff", "--no-color", from, to], { cwd: v.cwd }).catch((e) => ({ code: 1, stdout: "", stderr: String(e) })),
        exec("git", ["diff", "--numstat", from, to], { cwd: v.cwd }).catch(() => ({ code: 1, stdout: "" })),
      ]);
      if (this.diffKey !== key) return;
      const lines = r.code === 0 ? r.stdout.split("\n") : [`git diff failed: ${r.stderr}`];
      const files = n.code === 0 ? n.stdout.split("\n").filter(Boolean).map((l) => { const [add, del, file] = l.split("\t"); return { add, del, file }; }) : [];
      this.diff = { lines: lines.slice(0, MAX_LINES), cut: lines.length > MAX_LINES, empty: r.code === 0 && !r.stdout.trim(), files };
      cx.notify();
    });
  }

  setReviewed(address, sha, cx) {
    const file = `${dirOf(address)}/reviewed`;
    cx.spawn(async () => {
      const prev = await readTextFile(file).catch(() => null);
      await writeTextFile(file, sha, prev).catch(() => {});
    });
  }

  // Back to work: an agent that started again after its checkpoint isn't done with it.
  blockedReview(it) {
    if (!it?.v.latest) return "No checkpoint yet";
    if (it.v.latest.sha === it.v.reviewed) return "Reviewed";
    if (it.a.status === "working") return "Working again since this checkpoint";
    if (it.v.latest.checks === "running") return "Checks are still running";
    return null;
  }

  markReviewed(cx) {
    const it = this.current();
    if (!it || this.blockedReview(it)) return;
    this.setReviewed(it.a.address, it.v.latest.sha, cx);
    it.v.reviewed = it.v.latest.sha;
    this.turn = null;
    this.loadDiff(cx);
    it.rank = rank(it.a, it.v, Date.now());
    this.next(cx);
  }

  sendFailures(cx) {
    const it = this.current();
    const failed = it?.v.latest?.results?.filter((r) => !r.ok);
    if (!failed?.length) return;
    const text = "Kodr ran the project's checks on your last checkpoint and these failed. Fix them:\n\n" +
      failed.map((r) => `${r.name}:\n\`\`\`\n${r.tail.trim()}\n\`\`\``).join("\n\n");
    const t = it.a.address;
    cx.spawn(async () => { await hc(["send", t, text]); });
  }

  next(cx) {
    const open = this.items.filter((i) => i.rank < 3);
    const it = open.find((i) => i.a.address !== this.selected) ?? open[0];
    if (it) this.select(it.a.address, cx);
  }

  // ---- drawing

  button(id, label, t, kind, onClick, disabled = null) {
    return div().id(id).px(10).h(24).flex().items_center().rounded(4).text_size(12)
      .when(Boolean(disabled), (el) => el.border_1().border_color(t.border).text_color(t.dim))
      .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx))
        .when(kind === "primary", (el) => el.bg(t.solid).text_color(t.solid_foreground))
        .when(kind !== "primary", (el) => el.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))))
      .child(label);
  }

  checksMark(checks, t) {
    const m = { pass: ["check", t.done], fail: ["x", t.blocked], running: ["dot", t.working] }[checks];
    if (!m) return div().w(12);
    return m[0] === "dot" ? div().size(6).mx(3).rounded(1).bg(m[1]) : svg(icon(m[0])).size(12).flex_none().text_color(m[1]);
  }

  entry(it, t) {
    const { a, v } = it;
    const color = [t.blocked, t.blocked, t.done, t.working, t.dim][it.rank];
    const open = this.openTurns(v);
    const selected = a.address === this.selected;
    const meta = [open.length ? `${open.length} turn${open.length > 1 ? "s" : ""} to review` : null, statLine(v.latest?.stat)].filter(Boolean).join(" · ");
    return v_flex().id(`e-${a.address}`).px(12).py(9).gap(3).cursor_pointer()
      .border_b(1).border_color(t.border).when(selected, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.select(a.address, cx))
      .child(h_flex().gap(8).items_center()
        .child(div().size(6).flex_none().rounded(1).bg(color))
        .child(div().flex_1().min_w(0).truncate().font_medium().child(a.title || "Claude Code"))
        .child(div().flex_none().text_size(11).text_color(color).child(REASON[it.rank])))
      .child(h_flex().pl(14).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${a.space_name} / ${a.tab_name}${meta ? ` · ${meta}` : ""}`))
        .child(this.checksMark(v.latest?.checks, t)));
  }

  turnStrip(v, t) {
    const open = this.openTurns(v);
    if (!open.length) return null;
    const chip = (id, label, on, checks, onClick) => h_flex().id(id).h(24).px(8).gap(6).items_center().rounded(4).cursor_pointer().text_size(12)
      .border_1().border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.selected)).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => onClick(cx))
      .when(checks !== undefined, (el) => el.child(this.checksMark(checks, t))).child(label);
    return h_flex().flex_none().px(12).py(8).gap(6).items_center().border_b(1).border_color(t.border).overflow_hidden()
      .child(chip("turn-all", open.length > 1 ? `All ${open.length} turns` : "This turn", !this.turn, undefined, (cx) => { this.turn = null; this.loadDiff(cx); cx.notify(); }))
      .when(open.length > 1, (el) => el.children(open.map((x) => chip(`turn-${x.sha}`, `#${x.n} · ${statLine(x.stat)}`, this.turn === x.sha, x.checks,
        (cx) => { this.turn = x.sha; this.loadDiff(cx); cx.notify(); }))));
  }

  diffLine(line, i, t) {
    if (line.startsWith("diff --git")) {
      const file = line.replace(/^diff --git a\/(.*) b\/.*$/, "$1");
      const st = this.diff.files.find((f) => f.file === file);
      return h_flex().id(`d${i}`).mt(i ? 12 : 0).h(30).px(12).gap(10).items_center().bg(t.chrome).border_t(1).border_b(1).border_color(t.border)
        .child(svg(icon("file")).size(13).text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(file))
        .when(Boolean(st), (el) => el.child(div().text_color(t.ansi2).child(`+${st.add}`)).child(div().text_color(t.ansi1).child(`−${st.del}`)));
    }
    if (/^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) return div().id(`d${i}`).h(0);
    const add = line.startsWith("+"), del = line.startsWith("-"), hunk = line.startsWith("@@");
    return h_flex().id(`d${i}`).min_h(19).px(12)
      .when(add, (el) => el.bg(t.ansi2 + "1f")).when(del, (el) => el.bg(t.ansi1 + "1f"))
      .when(hunk, (el) => el.mt(4).text_color(t.dim))
      .child(div().w(14).flex_none().text_color(add ? t.ansi2 : del ? t.ansi1 : t.dim).child(add ? "+" : del ? "−" : ""))
      .child(div().flex_1().min_w(0).text_color(hunk ? t.dim : add || del ? t.foreground : t.muted).child(hunk ? line : line.slice(1) || " "));
  }

  detail(t) {
    const it = this.current();
    if (!it) return v_flex().flex_1().h_full().items_center().justify_center().gap(6).text_color(t.dim).text_size(12.5)
      .child(div().text_size(14).text_color(t.muted).child("Nothing to review"))
      .child("Start Claude (Kodr) from herdr's + menu. Each turn it finishes shows up here with its checks.");
    const { a, v } = it;
    const failed = v.latest?.results?.filter((r) => !r.ok) ?? [];
    const blocked = this.blockedReview(it);
    const mono = settings().font_family ?? "monospace";
    const [from, to] = v.latest ? this.range(v) : [null, null];
    return v_flex().flex_1().h_full().min_w(0).min_h(0)
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().font_medium().child(a.title || "Claude Code"))
          .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${a.space_name} / ${a.tab_name}`)))
        .child(this.button("open", "Open chat", t, "plain", () => run("agent.focus", { terminal: a.address })))
        .when(failed.length > 0, (el) => el.child(this.button("send", "Send failures", t, "plain", (cx) => this.sendFailures(cx))))
        .when(Boolean(v.latest) && v.latest.sha !== v.reviewed, (el) => el.child(this.button("ok", "Mark reviewed", t, "primary", (cx) => this.markReviewed(cx), blocked))))
      .child(h_flex().h(28).flex_none().px(12).gap(10).items_center().text_size(11.5).text_color(t.dim).border_b(1).border_color(t.border)
        .child(v.latest ? `${from?.slice(0, 7)} → ${to?.slice(0, 7)}` : "No checkpoint yet")
        .when(Boolean(v.latest?.results), (el) => el.children(v.latest.results.map((r, i) =>
          h_flex().id(`c${i}`).gap(4).items_center().text_color(r.ok ? t.done : t.blocked)
            .child(svg(icon(r.ok ? "check" : "x")).size(11)).child(r.name))))
        .when(v.latest?.checks === "running", (el) => el.child(div().text_color(t.working).child("checks running")))
        .child(div().flex_1())
        .when(Boolean(blocked) && blocked !== "Reviewed" && Boolean(v.latest), (el) => el.child(div().text_color(t.working).child(blocked))))
      .child(this.turnStrip(v, t) ?? div())
      .child(v_flex().id("review-body").flex_1().min_h(0).overflow_y_scrollbar().font_family(mono).text_size(12)
        .children(failed.map((r, i) => v_flex().id(`f${i}`).m(12).rounded(4).border_1().border_color(t.blocked).bg(t.chrome).overflow_hidden()
          .child(h_flex().px(10).py(6).gap(6).items_center().border_b(1).border_color(t.border).text_color(t.blocked)
            .child(svg(icon("x")).size(12)).child(`${r.name} failed`))
          .child(div().px(10).py(8).text_color(t.muted).child(r.tail.trim() || "(no output)"))))
        .child(this.diff
          ? (this.diff.empty
            ? div().p(16).text_color(t.dim).child(this.turn ? "This turn changed nothing." : "No changes since the last review.")
            : v_flex().pb(12).children(this.diff.lines.map((l, i) => this.diffLine(l, i, t)))
                .when(this.diff.cut, (el) => el.child(div().p(12).text_color(t.dim).child(`Showing the first ${MAX_LINES} lines.`))))
          : div().p(16).text_color(t.dim).child(v.latest ? "Loading the diff…" : "This session hasn't finished a turn with changes yet.")));
  }

  render(cx) {
    const t = theme();
    const open = this.items.filter((i) => i.rank < 3).length;
    return h_flex().id("kodr-review").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(v_flex().w(320).h_full().flex_none().min_h(0).bg(t.chrome).border_r(1).border_color(t.border)
        .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().flex_1().font_medium().child("Review"))
          .child(div().text_size(11.5).text_color(open ? t.foreground : t.dim).child(open ? `${open} open` : "all clear"))
          .child(this.button("next", "Next", t, "plain", (cx) => this.next(cx), open ? null : "Nothing open")))
        .child(v_flex().id("review-list").flex_1().min_h(0).overflow_y_scrollbar().children(this.items.map((i) => this.entry(i, t)))
          .when(!this.items.length, (el) => el.child(div().p(12).text_size(12).text_color(t.dim).child("No Kodr sessions running.")))))
      .child(this.detail(t));
  }
}
