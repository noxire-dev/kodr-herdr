// Mission control, in the kodr layout's side panel beside Files and Changes (the Mission button in the
// tab bar, or Ctrl+Shift+G). One stack for the shown space's repo, attention first: its agents (status, stage,
// tasks done/total; click to go), Kodr's own todo board (feed/kodr-todo.mjs: agents add and move their todos,
// you can too; no GitHub needed), then the Rinai issues when Rinai is installed. Below: the Rinai board (rinai.dev, over GitHub issues) of the shown space's
// repository, grouped by column, each card with the Claude working on it. A filter and chips (All,
// Cycle, Waiting on you, Mine) narrow it. A card opens in the panel: its agent (Go to) or Start
// (claims it, makes its worktree, a branch rinai/<N>-... off the default branch, then a Claude in a
// space for it told to read the brief with gh rinai brief N), its worktree (Open, Remove), Move, the
// brief. An agent is tied to its card by a terminal label set at Start (rinai.issue = owner/repo#N);
// Rinai itself only records the claim (assignee + Ongoing).
// Per repo (the gear, ~/.kodr-herdr/repos.json): a setup command run in a new worktree before its Claude starts,
// an accept command run in the main checkout after a card is Done, review rounds (after Send to its Claude, the
// review runs again when its turn ends, up to the limit), and auto-merge (off by default). After a merge the
// worktree and branch go unless they hold work the merge doesn't. Rows show the Claude's tasks done/total and time.
// Data: feed/kodr-mission.mjs (gh rinai); grouping and the space's real folder: board.js.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView, InputState, Input } from "gpui-base";
import { lanes, folderOf, mergeStep } from "./board.js";
import { spaces, panes, agents, terminals, home, readTextFile, exec, hc, run, theme, nextCommand } from "herdr";

const icon = (name) => `mods/kodr-mission/${name}.svg`;
const LABEL = "rinai.issue";
const COLUMNS = [["todo", "Todo"], ["ongoing", "Ongoing"], ["in-review", "In review"], ["blocked", "Blocked"], ["future", "Future"], ["done", "Done"]];
const COLUMN = Object.fromEntries(COLUMNS);
const ORDER = ["blocked", "ongoing", "in-review", "todo", "future", "done"]; // attention first
const FILTERS = [["all", "All"], ["cycle", "Cycle"], ["waiting", "Waiting on you"], ["mine", "Mine"]];
const PRIORITY = { urgent: "blocked", high: "working" };
const STATUS = { working: "Claude working", blocked: "Claude needs you", done: "Claude finished", idle: "Claude idle" };
const REFRESH_MS = 60_000;
const mins = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`; };
const elapsed = (since) => { const m = Math.floor((Date.now() - since) / 60000); return m < 1 ? "<1m" : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`; };
const ago = (at) => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  return s < 60 ? "just now" : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

// A worktree's review in a card row's second line.
const reviewLine = (r) => !r ? "worktree" : r.state === "running" ? "reviewing" : r.state === "error" ? "review failed"
  : r.stale ? "review out of date" : r.fix ? `review: ${r.fix} to fix` : "reviewed clean";
const LEVEL = { blocker: "blocked", major: "working", minor: "dim" };

// An agent's name in a row: the title it set (minus its status glyph), else its tab's, else its program's.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").trim();
const agentName = (a) => clean(a.title) || (/^\d+$/.test(a.tab_name ?? "") ? null : a.tab_name) || a.program?.name || a.address;
const TODO_ORDER = ["blocked", "ongoing", "in-review", "todo", "done"];
const TODO_TITLE = { blocked: "Blocked", ongoing: "Ongoing", "in-review": "In review", todo: "Todo", done: "Done" };
const TODO_COLOR = { blocked: "blocked", ongoing: "working", "in-review": "accent", done: "done" };
const RANK = { blocked: 0, working: 1, done: 2 };

// Same folder, whichever slashes and case Herdr and git each use.
const norm = (p) => (p ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const same = (a, b) => norm(a) === norm(b);

export default class KodrMission extends View {
  init(_props, cx) {
    this.folder = null; // the folder the board is for
    this.board = null;
    this.worktrees = []; // the repo's checkouts on rinai/<N>-… branches: {n, branch, path}
    this.error = null;
    this.loading = false;
    this.at = 0;
    this.selected = null; // the open card's number
    this.briefs = new Map(); // number → brief text | {error}
    this.filter = "all";
    this.closed = new Set(["future", "done", "tg-done"]); // folded groups (Done todos too)
    this.busy = null; // "start" | "move:<col>" while it runs
    this.note = null; // the last action's failure
    this.query = InputState.new({ placeholder: "Filter agents' todos and issues" });
    this.query.on("change", (_e, cx) => cx.notify());
    this.progress = {}; // terminal → {done, total, since}
    this.accepts = {}; // card number → the accept command's last run
    this.repoSettings = null; // {key, setup, accept, autoMerge, rounds}
    this.pending = null; // a Start waiting on its worktree's setup: {card, wt}
    this.settingsOpen = false;
    this.setupInput = InputState.new({ placeholder: "npm ci" });
    // Kodr's own todos: the repo's board, the open todo, the add box.
    this.todos = null; // {key, name, cards}
    this.todoSel = null;
    this.adding = false;
    this.rinaiError = null; // Rinai not installed / not a GitHub repo: Issues says so, the rest works
    this.stages = {}; // terminal → {stage, done, total}
    this.newTodo = InputState.new({ placeholder: "What needs doing?" });
    this.newTodo.on("submit", (_e, cx) => this.addTodo(cx));
    // yap, when it runs: questions and blockers sessions sent you (Reply answers with --re), the board's notes, claims.
    this.yap = null; // {asks, notes, claims} | {down: true}
    this.replying = null; // the ask id whose reply box is open
    this.replyBox = InputState.new({ placeholder: "Your answer" });
    this.replyBox.on("submit", (_e, cx) => this.sendReply(cx));
    this.answered = new Set(); // asks replied to here, hidden until yap drops them
    this.acceptInput = InputState.new({ placeholder: "git pull && npm run deploy" });
    cx.spawn(async (cx) => {
      this.config = JSON.parse((await readTextFile(`${home()}/.kodr-herdr/config.json`).catch(() => null)) ?? "null");
      this.tick(cx);
    });
    cx.timer.every(2000, (cx) => this.tick(cx));
    // "kodr-mission.open-<N>" opens that Rinai card, "kodr-mission.board" goes back, "kodr-mission.settings" the repo settings.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand(), n = /^open-(\d+)$/.exec(c)?.[1];
        if (n) { this.wanted = Number(n); if (this.board) { this.open(this.wanted, cx); this.wanted = null; } }
        else if (c === "board") { this.wanted = null; this.open(null, cx); }
        else if (c === "settings") { this.open(null, cx); this.openSettings(cx); }
        // "kodr-mission.todo-<N>" opens Kodr todo T<N>; "kodr-mission.add-todo" opens the add box.
        else if (/^todo-\d+$/.test(c)) { this.open(null, cx); this.todoSel = Number(c.slice(5)); cx.notify(); }
        else if (c === "add-todo") { this.open(null, cx); this.adding = true; this.closed.delete("s-todos"); cx.notify(); }
      }
    });
  }

  space() { return spaces().find((w) => w.active && !w.machine) ?? null; }

  // Follow the shown space; reread its board every minute.
  tick(cx) {
    if (!this.config) return;
    const folder = folderOf(this.space(), panes());
    if (folder !== this.folder) {
      // A card's worktree space shows the same board: keep the board and the open card until the
      // new folder's board turns out to be another repo's.
      this.folder = folder;
      this.error = null; this.note = null; this.todos = null; this.todoSel = null; this.stages = {}; this.todosAt = 0; this.yap = null; this.yapAt = 0; this.replying = null;
      if (folder) this.load(cx);
      else { this.board = null; this.selected = null; }
      cx.notify();
    } else if (folder && !this.loading && Date.now() - this.at > REFRESH_MS) this.load(cx);
    else if (this.pending || this.worktrees.some((w) => w.review?.state === "running" || w.setup?.state === "running" || w.rounds?.waiting)
      || Object.values(this.accepts).some((a) => a?.state === "running") || this.selected != null) this.loadWorktrees(cx);
    else cx.notify(); // agent status and "updated" stay current
    if (this.board && Date.now() - (this.progressAt ?? 0) > 10_000) this.loadProgress(cx);
    if (folder && Date.now() - (this.todosAt ?? 0) > 3000) this.loadTodos(cx);
    if (folder && Date.now() - (this.stagesAt ?? 0) > 6000) this.loadStages(cx);
    if (folder && Date.now() - (this.yapAt ?? 0) > 5000) this.loadYap(cx);
  }

  // ---- yap: what sessions asked you, the board's notes and claims (feed/kodr-yap.mjs control)

  async yapCli(...args) {
    const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-yap.mjs`, ...args]);
    let out;
    try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim() || "No answer from yap"); }
    if (out.error) throw new Error(out.error);
    return out;
  }

  loadYap(cx) {
    if (this.yapLoading) return;
    this.yapLoading = true; this.yapAt = Date.now();
    const folder = this.folder;
    cx.spawn(async (cx) => {
      try {
        const y = await this.yapCli("control", folder);
        if (folder === this.folder) {
          const live = new Set((y.asks ?? []).map((a) => a.id));
          for (const id of this.answered) if (!live.has(id)) this.answered.delete(id);
          if (JSON.stringify(y) !== JSON.stringify(this.yap)) { this.yap = y; cx.notify(); }
        }
      } catch {}
      this.yapLoading = false;
    });
  }

  // The person's answer goes to whoever asked (yap finds the asker from the id) and takes the ask off the list.
  sendReply(cx) {
    const ask = this.yap?.asks?.find((a) => a.id === this.replying);
    const text = this.replyBox.value().trim();
    if (!ask || !text || this.busy) return;
    this.busy = "reply"; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.yapCli("say", this.folder, "everyone", text, "--re", ask.id);
        this.answered.add(ask.id); this.replying = null; this.replyBox.set_value("");
        this.yapAt = 0; this.loadYap(cx);
      } catch (e) { this.note = `Didn't send: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  // Take a note off the board: the first click asks.
  unnote(n, cx) {
    if (this.busy) return;
    if (this.confirmNote !== n.id) { this.confirmNote = n.id; cx.notify(); return; }
    this.confirmNote = null; this.busy = "unnote";
    cx.spawn(async (cx) => {
      try { await this.yapCli("unnote", this.folder, String(n.id)); this.yap.notes = this.yap.notes.filter((x) => x.id !== n.id); this.yapNote = null; }
      catch (e) { this.yapNote = `Didn't take it down: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  askRow(t, a) {
    const open = this.replying === a.id;
    const color = a.kind === "blocker" ? t.blocked : t.accent;
    return v_flex().id(`ask-${a.id}`).mx(6).px(8).py(7).gap(6).rounded(5)
      .child(h_flex().gap(8).items_start()
        .child(div().mt(1).px(5).h(17).flex().flex_none().items_center().rounded(3).border_1().border_color(color).text_size(10.5).text_color(color).child(a.kind))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().text_size(11.5).text_color(t.dim).child(`@${a.from} asks`))
          .child(div().text_size(12.5).text_color(t.foreground).child(a.text.length > 600 ? `${a.text.slice(0, 600)}…` : a.text)))
        .when(!open, (el) => el.child(this.button(`ask-r-${a.id}`, "Reply", t, "plain", (cx) => {
          this.replying = a.id; this.replyBox.set_value(""); this.yapNote = null; cx.notify();
        }, Boolean(this.busy)))))
      .when(open, (el) => el.child(h_flex().ml(48).h(30).px(8).gap(6).items_center().rounded(5).border_1().border_color(t.accent).bg(t.background)
        .child(Input.new(this.replyBox).flex_1().h_full().text_size(12.5))
        .child(this.button(`ask-x-${a.id}`, "Cancel", t, "plain", (cx) => { this.replying = null; cx.notify(); }))
        .child(this.button(`ask-s-${a.id}`, this.busy === "reply" ? "Sending…" : "Send", t, "primary", (cx) => this.sendReply(cx), Boolean(this.busy)))));
  }

  // The yap board: notes (take one down, asks once) and who claims what.
  yapView(t, quiet) {
    if (!this.yap) return quiet("Asking yap…");
    if (this.yap.down) return quiet("yap isn't running. Start it with: yap start");
    const notes = this.yap.notes ?? [], claims = this.yap.claims ?? [];
    return v_flex()
      .when(!notes.length && !claims.length, (el) => el.child(quiet("No notes or claims on this repo's board.")))
      .children(notes.map((n) => h_flex().id(`yn${n.id}`).mx(6).px(8).py(6).gap(10).items_start().rounded(5)
        .child(div().w(30).pt(1).flex_none().font_family("monospace").text_size(11.5).text_color(t.dim).child(`#${n.id}`))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().text_size(12.5).text_color(t.foreground).child(n.text.length > 400 ? `${n.text.slice(0, 400)}…` : n.text))
          .child(div().text_size(11).text_color(t.dim).child(`${n.author.replace(/^session /, "")} · ${ago(n.at)}`)))
        .child(div().id(`yn-rm${n.id}`).px(6).h(22).flex().flex_none().items_center().rounded(4).text_size(11)
          .text_color(this.confirmNote === n.id ? t.blocked : t.dim)
          .when(this.confirmNote === n.id, (el) => el.bg(t.blocked + "1f"))
          .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.blocked)).on_click((_e, cx) => this.unnote(n, cx)))
          .child(this.confirmNote === n.id ? "Take down?" : "Take down"))))
      .when(claims.length > 0, (el) => el.child(div().px(36).pt(6).pb(2).text_size(11).text_color(t.dim).child("Claims"))
        .children(claims.map((c) => h_flex().id(`yc${c.id}`).mx(6).pl(36).pr(8).py(3).gap(8).items_center()
          .child(div().min_w(0).truncate().font_family("monospace").text_size(11.5).text_color(t.muted).child(c.path))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(`@${c.name}${c.why ? ` · ${c.why}` : ""}`)))))
      .when(Boolean(this.yapNote), (el) => el.child(quiet(this.yapNote, t.blocked)));
  }

  // ---- Kodr's own todos and the repo's agents

  async todoCli(...args) {
    const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-todo.mjs`, "--cwd", this.folder, "--json", ...args]);
    let out;
    try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim() || "No answer from kodr-todo"); }
    if (out.error) throw new Error(out.error);
    return out;
  }

  loadTodos(cx) {
    if (this.todosLoading) return;
    this.todosLoading = true; this.todosAt = Date.now();
    const folder = this.folder;
    cx.spawn(async (cx) => {
      try {
        const b = await this.todoCli("board");
        if (folder === this.folder && JSON.stringify(b) !== JSON.stringify(this.todos)) { this.todos = b; cx.notify(); }
      } catch {}
      this.todosLoading = false;
    });
  }

  // The live agents working in this repo: its main checkout, its worktrees, or on one of its Rinai cards.
  repoAgents() {
    const key = norm(this.todos?.key ?? this.folder);
    if (!key) return [];
    const roots = [key, ...this.worktrees.map((w) => norm(w.path))];
    const cwd = new Map(panes().map((p) => [p.pane, norm(p.cwd)]));
    const labelled = new Set(terminals().filter((x) => this.board && x.labels?.[LABEL]?.startsWith(`${this.board.repo}#`)).map((x) => x.address));
    return agents().filter((a) => labelled.has(a.address) || roots.some((r) => { const c = cwd.get(a.pane); return c && (c === r || c.startsWith(`${r}/`)); }));
  }

  loadStages(cx) {
    this.stagesAt = Date.now();
    const ts = this.repoAgents().map((a) => a.address).filter((a) => !a.includes("/"));
    if (!ts.length) return;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-stages.mjs`, ...ts]);
        this.stages = JSON.parse(r.stdout || "{}");
        cx.notify();
      } catch {}
    });
  }

  todoAct(verb, card, args, cx) {
    if (this.busy) return;
    this.busy = `todo:${verb}`; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.todoCli(verb, String(card.id), ...args);
        if (verb === "rm") this.todoSel = null;
        this.todosAt = 0; this.loadTodos(cx);
      } catch (e) { this.note = String(e?.message ?? e); }
      this.busy = null;
      cx.notify();
    });
  }

  addTodo(cx) {
    const title = this.newTodo.value().trim();
    if (!title || this.busy) return;
    this.busy = "todo:add";
    cx.spawn(async (cx) => {
      try { await this.todoCli("add", title); this.newTodo.set_value(""); this.adding = false; this.todosAt = 0; this.loadTodos(cx); this.note = null; }
      catch (e) { this.note = String(e?.message ?? e); }
      this.busy = null;
      cx.notify();
    });
  }

  // The agent on a todo: the one that started it, while its terminal is live and the todo isn't finished.
  // Adding a todo doesn't tie it: agents plan work they never get to.
  todoAgent(card) {
    const a = card.owner && card.column !== "done" && agents().find((x) => x.address === card.owner);
    return a ? { terminal: a.address, status: a.status, name: agentName(a) } : null;
  }

  // A Claude in the repo's folder, told to take this todo (it reads the details itself).
  startTodo(card, cx) {
    if (this.busy) return;
    this.busy = "todo:launch"; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const cli = `node "${this.config.root}/feed/kodr-todo.mjs"`;
        const task = `Take Kodr todo T${card.id}: ${card.title.replace(/["\`$]/g, "")}. Run ${cli} start ${card.id} now and ${cli} show ${card.id} for its details; note progress with ${cli} note ${card.id}, and ${cli} done ${card.id} when it's finished.`;
        const space = this.space();
        const r = await exec(this.config.herdrApp, ["do", "tab.new", JSON.stringify({ ...(space ? { space: space.id } : {}), folder: this.folder, argv: this.config.launch, task })]);
        const made = JSON.parse(r.stdout || "{}");
        if (!made.terminal) throw new Error(made.error || r.stderr.trim() || "The agent didn't open");
        // Started from here, the todo is the new agent's: its terminal becomes the owner.
        await this.todoCli("start", String(card.id), "--by", made.terminal).catch(() => {});
        this.todosAt = 0; this.loadTodos(cx);
      } catch (e) { this.note = `Didn't start: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  // Each card Claude's task list (done/total) and session age, for rows and cards.
  loadProgress(cx) {
    this.progressAt = Date.now();
    const ts = terminals().filter((x) => x.state === "live" && x.labels?.[LABEL]?.startsWith(`${this.board.repo}#`)).map((x) => x.address);
    if (!ts.length) return;
    cx.spawn(async (cx) => {
      try { this.progress = await this.feed("progress", ...ts); } catch {}
      cx.notify();
    });
  }

  // "3/5 tasks · 12m": the agent's task list and how long it has run.
  progressLine(agent) {
    const p = agent && this.progress[agent.terminal];
    if (!p) return null;
    return [p.total ? `${p.done}/${p.total} tasks` : null, p.since ? elapsed(p.since) : null].filter(Boolean).join(" · ") || null;
  }

  // Only the checkouts and their reviews: cheap, so it runs every tick while a review is going or a card
  // with a worktree is open (a new commit there makes its review stale).
  loadWorktrees(cx) {
    const folder = this.folder;
    if (this.wtLoading) return;
    this.wtLoading = true;
    cx.spawn(async (cx) => {
      try {
        const wt = await this.feed("worktrees", folder);
        if (folder === this.folder) { this.worktrees = wt.worktrees; this.accepts = wt.accepts ?? {}; this.repoSettings = wt.settings ?? this.repoSettings; }
      } catch {}
      this.wtLoading = false;
      this.resume(cx);
      cx.notify();
    });
  }

  // A read-only Claude on the branch's diff (feed/kodr-mission.mjs review); the card shows what it finds.
  review(wt, cx) {
    if (this.busy) return;
    this.busy = "review"; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.feed("review", wt.path, String(wt.n)); wt.review = { state: "running", at: Date.now() }; this.loadWorktrees(cx); }
      catch (e) { this.note = `Didn't start the review: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  // Push the branch and open its PR (or bring the PR up to the reviewed commit); then merge it.
  ship(verb, card, wt, cx) {
    if (this.busy) return;
    this.busy = verb; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const agent = this.agentFor(card.number);
        wt.pr = await this.feed(...(verb === "merge" ? ["merge", wt.path, ...(agent ? [agent.terminal] : [])] : ["pr", wt.path, String(card.number), card.title]));
        if (verb === "merge") {
          const c = wt.pr.cleanup;
          this.done = c?.removed ? `Merged PR #${wt.pr.number}. Removed the worktree and ${c.branch}.` : `Merged PR #${wt.pr.number}. Kept the worktree: ${c?.kept ?? "unknown"}.`;
          if (c?.removed) this.worktrees = this.worktrees.filter((w) => w !== wt);
          this.busy = null;
          this.move(card, "done", cx); // the board sees the PR merged, the issue closed; accept runs
        }
        this.loadWorktrees(cx);
      } catch (e) { this.note = `${verb === "merge" ? "Didn't merge" : "Didn't open the PR"}: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  // The last step, after the review: Open PR, Push to PR, Merge, Merged. Every click is the person's.
  mergeView(t, card, wt) {
    const step = mergeStep(wt.review, wt.pr, wt.head), pr = wt.pr, busy = Boolean(this.busy);
    const box = v_flex().mt(4).gap(8).px(12).py(10).rounded(4).border_1().border_color(t.border);
    const head = (label, color = t.foreground) => h_flex().gap(8).items_center().child(div().flex_1().min_w(0).text_size(12.5).text_color(color).child(label));
    const web = pr?.url ? this.button("m-pr-web", "View PR", t, "plain", () => exec("explorer", [pr.url]).catch(() => {})) : null;
    const hint = (text) => div().text_size(11.5).text_color(t.dim).child(text);
    if (step === "merged") return box.child(head(`Merged PR #${pr.number} into ${pr.base ?? "the default branch"}`, t.done).when(Boolean(web), (el) => el.child(web))
        .when(card.column !== "done", (el) => el.child(this.button("m-done", this.busy === "move:done" ? "Moving…" : "Move to Done", t, "primary", (cx) => this.move(card, "done", cx), busy))))
      .child(hint(pr.kept ? `Kept the worktree and branch: ${pr.kept}. Remove it above once that work is merged or dropped.` : "The worktree can go now: Remove, above."));
    if (step === "review") return box.child(head(pr ? `PR #${pr.number}` : "Merge", t.muted).when(Boolean(web), (el) => el.child(web)))
      .child(hint(pr ? "Merging waits for a clean review of the latest commit." : "Opens after a clean review of the latest commit: Kodr pushes the branch and opens a PR that closes the issue."));
    if (step === "empty") return box.child(head("Nothing to merge yet", t.muted)).child(hint("The branch has no commits beyond the default branch."));
    const auto = this.repoSettings?.autoMerge;
    if (step === "open") return box.child(head(auto ? "Ready to merge · auto-merge is on" : "Ready to merge").child(this.button("m-pr", this.busy === "pr" ? "Opening…" : "Open PR", t, "primary", (cx) => this.ship("pr", card, wt, cx), busy)))
      .child(hint(`Pushes ${wt.branch} and opens a PR into the default branch that closes #${card.number}.`));
    if (step === "push") return box.child(head(`PR #${pr.number} is behind this branch`).when(Boolean(web), (el) => el.child(web))
        .child(this.button("m-push", this.busy === "pr" ? "Pushing…" : "Push to PR", t, "primary", (cx) => this.ship("pr", card, wt, cx), busy)))
      .child(hint("The reviewed commit isn't on GitHub yet."));
    return box.child(head(`PR #${pr.number} holds the reviewed commit`).when(Boolean(web), (el) => el.child(web))
        .child(this.button("m-merge", this.busy === "merge" ? "Merging…" : "Squash and merge", t, "primary", (cx) => this.ship("merge", card, wt, cx), busy)))
      .child(hint(`GitHub refuses it if the PR changed since ${wt.head?.slice(0, 7)}, or its required checks haven't passed.`));
  }

  // The findings to fix, typed into the card's own Claude.
  // Arms review rounds: when its turn ends the review runs again on its own (feed: send).
  sendFindings(agent, wt, cx) {
    cx.spawn(async (cx) => {
      try { await this.feed("send", wt.path, String(wt.n), agent.terminal); wt.rounds = { terminal: agent.terminal, waiting: true }; this.note = null; }
      catch (e) { this.note = `Didn't reach its Claude: ${String(e?.message ?? e)}`; }
      cx.notify();
    });
  }

  async feed(...args) {
    const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-mission.mjs`, ...args], { timeout: 90_000 });
    let out;
    try { out = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim() || "No answer from gh rinai"); }
    if (out.error) throw new Error(out.error);
    return out;
  }

  load(cx) {
    const folder = this.folder;
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const [board, wt] = await Promise.all([this.feed("board", folder), this.feed("worktrees", folder).catch(() => ({ worktrees: [] }))]);
        if (folder !== this.folder) return;
        if (board.repo !== this.board?.repo) { this.selected = null; this.briefs.clear(); }
        this.board = board; this.worktrees = wt.worktrees; this.accepts = wt.accepts ?? {}; this.repoSettings = wt.settings ?? null; this.error = null;
        // A card asked for by command before its board arrived opens now.
        if (this.wanted != null) { this.open(this.wanted, cx); this.wanted = null; }
        this.rinaiError = null;
      } catch (e) {
        if (folder !== this.folder) return;
        // No Rinai here (not installed, not a GitHub repo, signed out): Issues says why; agents and todos carry on.
        this.board = null; this.selected = null;
        this.rinaiError = String(e?.message ?? e);
      }
      this.loading = false;
      this.at = Date.now();
      cx.notify();
    });
  }

  open(n, cx) {
    this.selected = n; this.todoSel = null;
    this.note = null; this.done = null; this.settingsOpen = false;
    if (n !== null && !(this.briefs.get(n) && !this.briefs.get(n).error)) {
      const folder = this.folder;
      this.briefs.set(n, null);
      cx.spawn(async (cx) => {
        try { this.briefs.set(n, (await this.feed("brief", folder, String(n))).brief); }
        catch (e) { this.briefs.set(n, { error: String(e?.message ?? e) }); }
        cx.notify();
      });
    }
    cx.notify();
  }

  // The live agent terminal started on this card, and its status.
  agentFor(n) {
    const key = `${this.board?.repo}#${n}`;
    const term = terminals().find((x) => x.state === "live" && x.labels?.[LABEL] === key);
    if (!term) return null;
    const a = agents().find((x) => x.address === term.address);
    return { terminal: term.address, status: a?.status ?? "idle" };
  }

  worktreeFor(n) { return this.worktrees.find((w) => w.n === n) ?? null; }

  // The space showing a folder, if any (a worktree space is named after its checkout).
  spaceAt(path) {
    return spaces().find((w) => !w.machine && same(folderOf(w, panes()), path)) ?? null;
  }

  // Claim it, put it in its own worktree (rinai/<N>-… from the default branch, made once and reused),
  // and start a Claude there in a space of its own, labelled with the card. Your checkout isn't touched.
  start(card, cx) {
    if (this.busy) return;
    this.busy = "start"; this.note = null;
    cx.notify();
    const folder = this.folder, repo = this.board.repo;
    cx.spawn(async (cx) => {
      try {
        await this.feed("claim", folder, String(card.number));
        const wt = await this.feed("worktree", folder, String(card.number), card.title);
        // A new worktree gets the repo's setup command first; its Claude starts when that finishes (resume).
        if (wt.made && this.repoSettings?.setup) {
          const r = await this.feed("setup", wt.path);
          if (r.ok) { this.pending = { card, n: wt.n }; this.busy = null; this.loadWorktrees(cx); return; }
        }
        await this.launch(card, wt, repo);
        this.load(cx);
      } catch (e) { this.note = `Didn't start: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  // A Start waiting on setup: launch when it's done; when it failed the card offers Retry setup / Start anyway.
  resume(cx) {
    const p = this.pending, wt = p && this.worktreeFor(p.n);
    if (!wt || wt.setup?.state === "running" || this.busy) return;
    this.pending = null;
    if (wt.setup?.state === "error") return;
    this.busy = "start";
    cx.spawn(async (cx) => {
      try { await this.launch(p.card, wt, this.board.repo); this.load(cx); }
      catch (e) { this.note = `Didn't start: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  retrySetup(card, wt, cx) {
    if (this.busy) return;
    this.busy = "setup"; this.note = null;
    cx.spawn(async (cx) => {
      try { await this.feed("setup", wt.path); wt.setup = { state: "running", at: Date.now() }; this.pending = { card, n: wt.n }; }
      catch (e) { this.note = `Didn't run setup: ${String(e?.message ?? e)}`; }
      this.busy = null;
      this.loadWorktrees(cx);
    });
  }

  startAnyway(card, wt, cx) {
    if (this.busy) return;
    this.busy = "start"; this.note = null;
    cx.spawn(async (cx) => {
      try { await this.launch(card, wt, this.board.repo); this.load(cx); }
      catch (e) { this.note = `Didn't start: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  async launch(card, wt, repo) {
    // One line: Herdr hands the first message over a command line, where a whole brief's quotes and
    // newlines don't survive. The agent reads the brief itself.
    const task = `Work Rinai issue #${card.number}: run \`gh rinai brief ${card.number}\` and do what it says. You are in its own worktree on branch ${wt.branch}. First run \`yap doing "#${card.number} ${card.title.replace(/["`$]/g, "")}"\` if yap is installed.`;
    const there = this.spaceAt(wt.path);
    // Spaces stay unnamed so they follow the checkout and nest under the repo's (as Herdr's New worktree does).
    const [cmd, args] = there ? ["tab.new", { space: there.id, folder: wt.path, argv: this.config.launch, task }]
      : ["space.new", { folder: wt.path, argv: this.config.launch, task }];
    const r = await exec(this.config.herdrApp, ["do", cmd, JSON.stringify(args)]);
    const made = JSON.parse(r.stdout || "{}");
    if (!made.terminal) throw new Error(made.error || r.stderr.trim() || "The agent didn't open");
    await hc(["label", made.terminal, `${LABEL}=${repo}#${card.number}`]);
  }

  openWorktree(wt) {
    const there = this.spaceAt(wt.path);
    if (there) run("space.select", { id: there.id });
    else run("space.new", { folder: wt.path });
  }

  // git worktree remove: refuses one with uncommitted changes; the branch stays.
  removeWorktree(wt, cx) {
    if (this.busy) return;
    this.busy = "remove"; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try { await this.feed("unworktree", this.folder, wt.path); this.worktrees = this.worktrees.filter((w) => w !== wt); }
      catch (e) { this.note = `Didn't remove the worktree: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  move(card, col, cx) {
    if (this.busy || card.column === col) return;
    this.busy = `move:${col}`; this.note = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.feed("move", this.folder, String(card.number), col); card.column = col;
        if (col === "done" && this.repoSettings?.accept) { await this.feed("accept", this.folder, String(card.number)); this.accepts[card.number] = { state: "running", at: Date.now() }; }
        this.load(cx);
      }
      catch (e) { this.note = `Didn't move: ${String(e?.message ?? e)}`; }
      this.busy = null;
      cx.notify();
    });
  }

  openOnWeb(card) {
    exec("explorer", [`https://rinai.dev/${this.board.repo}/issues/${card.number}`]).catch(() => {});
  }

  iconButton(id, name, t, onClick, disabled = false) {
    return div().id(id).size(26).flex().flex_none().items_center().justify_center().rounded(4)
      .text_color(disabled ? t.dim : t.muted)
      .when(!disabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx)))
      .child(svg(icon(name)).size(14));
  }

  button(id, label, t, kind, onClick, disabled = false) {
    return div().id(id).px(10).h(28).flex().flex_none().items_center().justify_center().rounded(4).text_size(12.5)
      .when(disabled, (el) => el.border_1().border_color(t.border).text_color(t.dim))
      .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx))
        .when(kind === "primary", (el) => el.bg(t.solid).text_color(t.solid_foreground))
        .when(kind !== "primary", (el) => el.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))))
      .child(label);
  }

  // A card's mark: its agent's status when one is on it (filled; a ring when idle), else its column's.
  mark(t, card, agent) {
    const d = div().size(8).flex_none().rounded(4);
    if (agent) return agent.status === "idle" ? d.border_1().border_color(t.muted) : d.bg(t[agent.status] ?? t.dim);
    const color = { blocked: t.blocked, ongoing: t.working, "in-review": t.accent, done: t.done }[card.column];
    return color ? d.border_1().border_color(color) : d.border_1().border_color(t.dim);
  }

  row(c, t) {
    const agent = this.agentFor(c.number);
    const pr = c.pulls?.find((p) => p.state === "open");
    const second = agent ? [STATUS[agent.status], this.progressLine(agent)].filter(Boolean).join(" · ") : [c.assignees?.length ? c.assignees.map((a) => `@${a}`).join(" ") : null,
      pr ? `PR #${pr.number}${pr.checks === "failure" ? " failing" : ""}` : null, this.worktreeFor(c.number) ? reviewLine(this.worktreeFor(c.number).review) : null,
      this.board.cycle?.open?.includes(c.number) ? "cycle" : null].filter(Boolean).join(" · ");
    return h_flex().id(`m${c.number}`).mx(6).px(8).py(6).gap(10).items_start().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(c.number, cx))
      .child(div().pt(5).flex_none().child(this.mark(t, c, agent)))
      .child(div().w(38).pt(1).flex_none().font_family("monospace").text_size(11.5).text_color(t.dim).child(`#${c.number}`))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(13).text_color(c.column === "done" ? t.muted : t.foreground).child(c.title))
        .when(Boolean(second), (el) => el.child(div().truncate().text_size(11.5).text_color(agent?.status === "blocked" ? t.blocked : t.dim).child(second))))
      .when(Boolean(PRIORITY[c.priority]), (el) => el.child(div().pt(1).flex_none().text_size(11).text_color(t[PRIORITY[c.priority]]).child(c.priority)))
      .when(c.waiting, (el) => el.child(div().pt(1).flex_none().text_size(11).text_color(t.accent).child("you")));
  }

  // Review before merge: start it, watch it run, read what it found. Merging stays yours.
  reviewView(t, wt, agent) {
    const r = wt.review, running = r?.state === "running";
    const limit = r?.limit ?? this.repoSettings?.rounds ?? 3;
    // Rounds show once findings went back to its Claude (or past the first).
    const roundTag = r && (wt.rounds || (r.round ?? 1) > 1)
      ? div().flex_none().text_size(11.5).text_color(t.dim).child(`Round ${r.round ?? 1} of ${limit}`) : null;
    const waiting = wt.rounds?.waiting && !running;
    const again = this.button("m-review", this.busy === "review" ? "Starting…" : r ? "Review again" : "Review", t, r ? "plain" : "primary",
      (cx) => this.review(wt, cx), Boolean(this.busy) || running);
    const head = h_flex().gap(8).items_center();
    const box = v_flex().mt(4).gap(8).px(12).py(10).rounded(4).border_1().border_color(t.border).bg(t.chrome);
    if (!r) return box.child(head.child(div().flex_1().text_size(12.5).text_color(t.foreground).child("Review before merge")).child(again))
      .child(div().text_size(11.5).text_color(t.dim).child("A read-only Claude reads this branch's diff against the default branch and the brief, then lists what to fix. It never edits or merges."));
    if (running) return box.child(head
      .child(div().size(8).rounded(4).bg(t.working).loop("opacity", { from: 0.25, to: 1, period: 1200 }))
      .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(`Reviewing… ${mins(Date.now() - r.at)}`))
      .when(Boolean(roundTag), (el) => el.child(roundTag)))
      .child(div().text_size(11.5).text_color(t.dim).child("Usually a minute or two. You can leave this card; it keeps going."));
    if (r.state === "error") return box.child(head.child(div().flex_1().text_size(12.5).text_color(t.blocked).child("The review failed")).child(again))
      .child(div().text_size(11.5).text_color(t.muted).child(r.error));
    const fix = r.findings.filter((f) => f.level !== "minor"), minor = r.findings.length - fix.length;
    const title = fix.length ? `${fix.length} to fix${minor ? ` · ${minor} minor` : ""}` : minor ? `Clean · ${minor} minor` : "Clean";
    return box
      .child(head.child(div().flex_1().text_size(12.5).font_medium().text_color(fix.length ? t.blocked : t.done).child(title))
        .when(Boolean(roundTag), (el) => el.child(roundTag))
        .when(fix.length > 0 && Boolean(agent) && !waiting, (el) => el.child(this.button("m-send", "Send to its Claude", t, "primary", (cx) => this.sendFindings(agent, wt, cx))))
        .child(again))
      .when(Boolean(waiting), (el) => el.child(h_flex().gap(8).items_center()
        .child(div().size(6).rounded(3).bg(t.working).loop("opacity", { from: 0.25, to: 1, period: 1200 }))
        .child(div().text_size(11.5).text_color(t.working).child(`Sent to its Claude. Round ${(r.round ?? 1) + 1} starts when its turn ends.`))))
      .when(!waiting && fix.length > 0 && Boolean(wt.rounds) === false && (r.round ?? 1) >= limit, (el) => el.child(div().text_size(11.5).text_color(t.blocked)
        .child(`Still ${fix.length} to fix after ${limit} rounds: the rounds stopped. Fix it with its Claude, then Review again.`)))
      .when(Boolean(r.summary), (el) => el.child(div().text_size(12).text_color(t.muted).child(r.summary)))
      .when(r.stale, (el) => el.child(div().text_size(11.5).text_color(t.working).child(`Reviewed ${r.head?.slice(0, 7)}; the branch has moved on since. Review again before merging.`)))
      .when(Boolean(r.dirty), (el) => el.child(div().text_size(11.5).text_color(t.dim).child("It had uncommitted changes; only commits are reviewed.")))
      .children(r.findings.map((f, i) => v_flex().id(`rf${i}`).gap(3).pt(8).border_t(1).border_color(t.border)
        .child(h_flex().gap(8).items_center()
          .child(div().px(5).h(17).flex().flex_none().items_center().rounded(3).border_1().border_color(t[LEVEL[f.level]] ?? t.dim)
            .text_size(10.5).text_color(t[LEVEL[f.level]] ?? t.dim).child(f.level))
          .child(div().flex_1().min_w(0).truncate().font_family("monospace").text_size(11.5).text_color(t.muted).child(`${f.file}${f.line ? `:${f.line}` : ""}`)))
        .child(div().text_size(12.5).text_color(t.foreground).child(f.what))
        .child(div().text_size(12).text_color(t.dim).child(`Fix: ${f.fix}`))))
      .child(div().pt(2).text_size(11).text_color(t.dim).child(`${r.base ? `Against ${r.base} · ` : ""}${mins(r.ms ?? 0)}${r.cost ? ` · ${r.cost.toFixed(2)}` : ""}`));
  }

  // A repo command's run (setup in the worktree, accept after Done): running, done, or failed with its output.
  jobView(t, id, job, label, actions) {
    if (!job) return null;
    const box = v_flex().mt(4).gap(6).px(12).py(10).rounded(4).border_1().border_color(job.state === "error" ? t.blocked : t.border);
    const head = h_flex().gap(8).items_center();
    if (job.state === "running") return box.child(head
      .child(div().size(8).rounded(4).bg(t.working).loop("opacity", { from: 0.25, to: 1, period: 1200 }))
      .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(`${label} running… ${mins(Date.now() - job.at)}`)))
      .when(Boolean(job.command), (el) => el.child(div().text_size(11.5).text_color(t.dim).font_family("monospace").child(job.command)));
    const failed = job.state === "error";
    return box.child(head.child(div().flex_1().text_size(12.5).font_medium().text_color(failed ? t.blocked : t.done)
        .child(failed ? `${label} failed${job.code != null && !job.error ? ` (exit ${job.code})` : ""}` : `${label} done · ${mins(job.ms ?? 0)}`))
        .children(failed ? actions : []))
      .child(div().text_size(11.5).text_color(t.dim).font_family("monospace").child(job.command ?? ""))
      .when(failed && Boolean(job.error), (el) => el.child(div().text_size(11.5).text_color(t.muted).child(job.error)))
      .when(failed && Boolean(job.out?.trim()), (el) => el.child(div().id(`${id}-out`).max_h(160).overflow_y_scrollbar().px(8).py(6).rounded(3).bg(t.chrome)
        .font_family("monospace").text_size(11).text_color(t.muted).child(job.out.trim())));
  }

  // The repo's own settings (~/.kodr-herdr/repos.json via the feed), behind the gear.
  settingsView(t) {
    const st = this.repoSettings ?? { setup: "", accept: "", autoMerge: false, rounds: 3 };
    const save = (patch, cx) => {
      this.busy = "settings";
      cx.spawn(async (cx) => {
        try { this.repoSettings = await this.feed("settings", this.folder, JSON.stringify(patch)); this.note = null; this.saved = Date.now(); }
        catch (e) { this.note = `Didn't save: ${String(e?.message ?? e)}`; }
        this.busy = null;
        cx.notify();
      });
    };
    const field = (label, hint, input) => v_flex().gap(4)
      .child(div().text_size(12.5).text_color(t.foreground).child(label))
      .child(h_flex().h(30).px(8).items_center().rounded(4).border_1().border_color(t.border).bg(t.background)
        .child(Input.new(input).flex_1().h_full().font_family("monospace").text_size(12)))
      .child(div().text_size(11.5).text_color(t.dim).child(hint));
    const toggle = (id, on, onClick) => div().id(id).w(30).h(17).flex_none().rounded(9).p(2).cursor_pointer().bg(on ? t.accent : t.selected)
      .on_click((_e, cx) => onClick(cx)).child(div().size(13).rounded(7).bg(t.background).when(on, (el) => el.ml(13)));
    return v_flex().id("m-settings").flex_1().min_h(0).overflow_y_scrollbar().px(16).pt(4).pb(14).gap(14)
      .child(div().text_size(15).font_medium().text_color(t.foreground).child("Repo settings"))
      .child(div().text_size(12).text_color(t.muted).child(`${st.key ?? this.board?.repo ?? ""} · this machine only`))
      .child(field("Setup command", "Runs in a new worktree before its Claude starts. Empty: none.", this.setupInput))
      .child(field("Accept command", "Runs in this checkout after a card moves to Done. Empty: none.", this.acceptInput))
      .child(h_flex().gap(10).items_start()
        .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12.5).text_color(t.foreground).child("Review rounds"))
          .child(div().text_size(11.5).text_color(t.dim).child("After Send to its Claude, the review runs again when its turn ends, up to this many rounds.")))
        .child(h_flex().gap(4).items_center()
          .child(this.button("m-r-less", "−", t, "plain", (cx) => save({ rounds: st.rounds - 1 }, cx), Boolean(this.busy) || st.rounds <= 1))
          .child(div().w(22).text_size(12.5).text_color(t.foreground).text_center().child(String(st.rounds)))
          .child(this.button("m-r-more", "+", t, "plain", (cx) => save({ rounds: st.rounds + 1 }, cx), Boolean(this.busy) || st.rounds >= 10))))
      .child(h_flex().gap(10).items_start()
        .child(v_flex().flex_1().min_w(0).gap(2).child(div().text_size(12.5).text_color(t.foreground).child("Auto-merge"))
          .child(div().text_size(11.5).text_color(st.autoMerge ? t.working : t.dim).child(st.autoMerge
            ? "On: a clean review of the latest commit opens the PR and squash-merges it, then moves the card to Done."
            : "Off: you open and merge each PR yourself.")))
        .child(toggle("m-auto", st.autoMerge, (cx) => save({ autoMerge: !st.autoMerge }, cx))))
      .child(h_flex().gap(8).items_center()
        .child(this.button("m-save", this.busy === "settings" ? "Saving…" : "Save commands", t, "primary",
          (cx) => save({ setup: this.setupInput.value().trim(), accept: this.acceptInput.value().trim() }, cx), Boolean(this.busy)))
        .when(Boolean(this.saved) && Date.now() - this.saved < 4000, (el) => el.child(div().text_size(11.5).text_color(t.done).child("Saved"))))
      .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.note)));
  }

  openSettings(cx) {
    const fill = (st) => { this.setupInput.set_value(st?.setup ?? ""); this.acceptInput.set_value(st?.accept ?? ""); };
    fill(this.repoSettings);
    this.settingsOpen = true; this.note = null;
    cx.notify();
    // Read them again: the file may have changed outside the panel (another window, the feed's CLI).
    cx.spawn(async (cx) => {
      try { this.repoSettings = await this.feed("settings", this.folder); fill(this.repoSettings); } catch {}
      cx.notify();
    });
  }

  message(t, text, color = t.dim) {
    return div().px(16).py(14).text_size(12.5).text_color(color).child(text);
  }

  // A section of the stack: a folding header with a count and an optional action on the right.
  section(t, key, title, count, open, action = null) {
    return h_flex().id(`s-${key}`).h(30).mx(6).mt(6).px(8).gap(8).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.closed.has(`s-${key}`) ? this.closed.delete(`s-${key}`) : this.closed.add(`s-${key}`); cx.notify(); })
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).text_color(t.dim))
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child(title))
      .child(div().text_size(11).text_color(t.dim).child(count == null ? "" : String(count)))
      .child(div().flex_1())
      .when(Boolean(action), (el) => el.child(action));
  }

  dot(t, status) {
    return status === "idle" ? div().size(8).rounded(4).border_1().border_color(t.muted) : div().size(8).rounded(4).bg(t[status] ?? t.dim);
  }

  agentRow(t, a) {
    const st = this.stages[a.address];
    const stage = st?.stage ?? (st?.total && st.done === st.total ? "All tasks done" : null);
    const status = { working: "working", blocked: "needs you", done: "finished", idle: "idle" }[a.status] ?? "";
    return h_flex().id(`a-${a.address}`).mx(6).px(8).py(6).gap(10).items_start().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(() => run("agent.focus", { terminal: a.address }))
      .child(div().pt(5).flex_none().child(this.dot(t, a.status)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center()
          .child(div().min_w(0).truncate().text_size(13).text_color(t.foreground).child(agentName(a)))
          .child(div().flex_none().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(status)))
        .when(Boolean(stage), (el) => el.child(div().truncate().text_size(11.5).text_color(a.status === "working" ? t.muted : t.dim).child(stage))))
      .when(Boolean(st?.total), (el) => el.child(div().pt(1).flex_none().text_size(11).text_color(t.dim).child(`${st.done}/${st.total}`)));
  }

  todoRow(t, c) {
    const agent = this.todoAgent(c);
    const color = TODO_COLOR[c.column];
    const mark = agent ? this.dot(t, agent.status) : div().size(8).rounded(4).border_1().border_color(color ? t[color] : t.dim);
    // Its latest word: the last note, else the first line of what it is.
    const said = c.notes?.at(-1)?.text ?? c.body?.trim().split(/\r?\n/)[0] ?? "";
    const second = [agent ? agent.name : null, said || null].filter(Boolean).join(" · ");
    return h_flex().id(`td${c.id}`).mx(6).px(8).py(6).gap(10).items_start().rounded(5).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.todoSel = c.id; this.selected = null; this.note = null; cx.notify(); })
      .child(div().pt(5).flex_none().child(mark))
      .child(div().w(30).pt(1).flex_none().font_family("monospace").text_size(11.5).text_color(t.dim).child(`T${c.id}`))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(13).text_color(c.column === "done" ? t.muted : t.foreground).child(c.title))
        .when(Boolean(second), (el) => el.child(div().truncate().text_size(11.5).text_color(c.column === "blocked" ? t.blocked : t.dim).child(second))))
      .child(div().pt(1).flex_none().text_size(11).text_color(t.dim).child(ago(c.updated ?? c.at)));
  }

  // The stack, attention first: agents, then Kodr's todos, then the Rinai issues.
  boardView(t) {
    if (!this.folder) return this.message(t, "Mission shows the repo of the space you're in. Open a space in a folder.");
    const q = this.query.value().trim().toLowerCase().replace(/^[#t]/, "");
    const hit = (c) => !q || String(c.id) === q || c.title.toLowerCase().includes(q);
    const ags = this.repoAgents().sort((x, y) => (RANK[x.status] ?? 3) - (RANK[y.status] ?? 3));
    const cards = (this.todos?.cards ?? []).filter(hit);
    const open = (k) => !this.closed.has(`s-${k}`) || Boolean(q);
    const add = this.iconButton("m-add", "plus", t, (cx) => { this.adding = !this.adding; this.closed.delete("s-todos"); cx.notify(); });
    const groups = TODO_ORDER.map((k) => ({ key: k, cards: cards.filter((c) => c.column === k).sort((a, b) => (b.updated ?? b.at) - (a.updated ?? a.at)) })).filter((g) => g.cards.length);
    const openTodos = (this.todos?.cards ?? []).filter((c) => c.column !== "done").length;
    const todoGroup = (g) => {
      const shut = this.closed.has(`tg-${g.key}`) && !q;
      return v_flex()
        .child(h_flex().id(`tg-${g.key}`).h(24).mx(6).pl(28).pr(8).gap(8).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.closed.has(`tg-${g.key}`) ? this.closed.delete(`tg-${g.key}`) : this.closed.add(`tg-${g.key}`); cx.notify(); })
          .child(div().text_size(11).text_color(g.key !== "done" && TODO_COLOR[g.key] ? t[TODO_COLOR[g.key]] : t.dim).child(TODO_TITLE[g.key]))
          .child(div().text_size(11).text_color(t.dim).child(String(g.cards.length)))
          .when(shut, (el) => el.child(svg(icon("chevron-right")).size(11).text_color(t.dim))))
        .when(!shut, (el) => el.children(g.cards.map((c) => this.todoRow(t, c))));
    };
    const quiet = (text, color = t.dim) => div().px(36).pb(6).text_size(12).text_color(color).child(text);
    const asks = (this.yap?.asks ?? []).filter((a) => !this.answered.has(a.id));
    return v_flex().flex_1().min_h(0)
      .child(h_flex().mx(12).mb(4).h(30).flex_none().px(8).gap(8).items_center().rounded(5).border_1().border_color(t.border).bg(t.background)
        .child(svg(icon("search")).size(14).text_color(t.dim))
        .child(Input.new(this.query).flex_1().h_full().text_size(12.5)))
      .child(v_flex().id("m-list").flex_1().min_h(0).pb(8).overflow_y_scrollbar()
        // Needs you: only while a session is waiting on the person.
        .when(asks.length > 0, (el) => el.child(this.section(t, "asks", "Needs you", asks.length, open("asks")))
          .when(open("asks"), (el) => el.children(asks.map((a) => this.askRow(t, a)))
            .when(Boolean(this.yapNote), (el) => el.child(quiet(this.yapNote, t.blocked)))))
        .child(this.section(t, "agents", "Agents", ags.length, open("agents")))
        .when(open("agents"), (el) => el.children(ags.map((a) => this.agentRow(t, a)))
          .when(!ags.length, (el) => el.child(quiet("No agents in this repo right now."))))
        .child(this.section(t, "todos", "Todos", openTodos, open("todos"), add))
        .when(open("todos"), (el) => el
          .when(this.adding, (el) => el.child(h_flex().mx(14).my(4).h(30).px(8).gap(8).items_center().rounded(5).border_1().border_color(t.accent).bg(t.background)
            .child(Input.new(this.newTodo).flex_1().h_full().text_size(12.5))
            .child(this.button("m-add-go", this.busy === "todo:add" ? "Adding…" : "Add", t, "primary", (cx) => this.addTodo(cx), Boolean(this.busy)))))
          .children(groups.map(todoGroup))
          .when(!groups.length, (el) => el.child(quiet(q ? "No todos match." : this.todos ? "No todos yet. Agents add them as they plan work; + adds one yourself." : "Reading the todos…")))
          .when(Boolean(this.note) && this.todoSel == null, (el) => el.child(quiet(this.note, t.blocked))))
        .child(this.section(t, "issues", "Issues · Rinai", this.board ? Object.values(this.board.columns).flat().filter((c) => c.column !== "done").length : null, open("issues")))
        .when(open("issues"), (el) => el.child(this.issuesView(t, quiet)))
        .child(this.section(t, "yap", "Board · yap", this.yap && !this.yap.down ? (this.yap.notes?.length ?? 0) : null, open("yap")))
        .when(open("yap"), (el) => el.child(this.yapView(t, quiet))));
  }

  issuesView(t, quiet) {
    if (this.rinaiError) return quiet(`Not connected: ${this.rinaiError}`);
    if (!this.board) return quiet("Reading the board…");
    const { lanes: groups, counts, total } = lanes(this.board, { filter: this.filter, query: this.query.value(), extra: true });
    const shown = ORDER.map((k) => groups.find((g) => g.key === k)).filter((g) => g.cards.length);
    const chips = h_flex().px(12).pb(8).gap(2).flex_wrap().children(FILTERS.map(([k, label]) => {
      const on = this.filter === k;
      return h_flex().id(`f-${k}`).h(25).px(7).gap(5).items_center().rounded(4).cursor_pointer().text_size(11.5)
        .bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.filter = k; cx.notify(); })
        .child(label).child(div().text_size(10.5).text_color(on ? t.accent : t.dim).child(String(counts[k])));
    }));
    const group = (g) => {
      const open = !this.closed.has(g.key) || Boolean(this.query.value().trim());
      return v_flex()
        .child(h_flex().id(`g-${g.key}`).h(28).mx(6).px(8).gap(8).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => { this.closed.has(g.key) ? this.closed.delete(g.key) : this.closed.add(g.key); cx.notify(); })
          .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).text_color(t.dim))
          .child(div().flex_1().text_size(12).text_color(t.muted).child(g.title))
          .child(div().text_size(11.5).text_color(t.dim).child(String(g.cards.length))))
        .when(open, (el) => el.children(g.cards.map((c) => this.row(c, t))));
    };
    return v_flex()
      .child(chips)
      .when(Boolean(this.board.truncated), (el) => el.child(quiet("The board was cut at GitHub's page limit; some cards are missing.", t.working)))
      .children(shown.map(group))
      .when(!shown.length, (el) => el.child(quiet(total === 0 ? `No issues on ${this.board.repo}'s board yet.`
        : this.query.value().trim() ? "No issues match." : this.filter === "waiting" ? "Nothing is waiting on you." : this.filter === "mine" ? "Nothing is assigned to you."
        : this.filter === "cycle" ? "Nothing is in the cycle." : "Nothing open.")));
  }

  todoCardView(t, card) {
    const agent = this.todoAgent(card);
    const busy = Boolean(this.busy);
    const nameOf = (term) => { const a = agents().find((x) => x.address === term); return a ? agentName(a) : `terminal ${term}`; };
    return v_flex().id("m-todo").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().px(16).pt(4).pb(14).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(15).font_medium().text_color(t.foreground).child(card.title))
        .child(div().text_size(12).text_color(t.muted).child(`T${card.id} · ${TODO_TITLE[card.column]} · added by ${card.by ? nameOf(card.by) : "you"} ${ago(card.at)}`))
        .when(Boolean(agent), (el) => el.child(h_flex().pt(4).gap(8).items_center()
          .child(h_flex().flex_1().min_w(0).h(28).px(10).gap(8).items_center().rounded(4).border_1().border_color(t.border)
            .child(this.dot(t, agent.status))
            .child(div().min_w(0).truncate().text_size(12.5).text_color(agent.status === "blocked" ? t.blocked : t.foreground).child(`${agent.name} · ${STATUS[agent.status] ?? agent.status}`)))
          .child(this.button("m-go", "Go to it", t, "primary", () => run("agent.focus", { terminal: agent.terminal })))))
        .when(!agent && card.column !== "done", (el) => el.child(div().pt(4).child(
          this.button("m-todo-start", this.busy === "todo:launch" ? "Starting…" : "Start a Claude on it", t, "primary", (cx) => this.startTodo(card, cx), busy)))
          .child(div().text_size(11.5).text_color(t.dim).child("Opens a Claude in this repo's space, told to take this todo. It marks it Ongoing and reports back here.")))
        .child(h_flex().pt(2).gap(2).flex_wrap().items_center()
          .children(TODO_ORDER.map((k) => div().id(`tm-${k}`).px(7).h(24).flex().items_center().rounded(4).text_size(11.5)
            .when(k === card.column, (el) => el.bg(t.selected).text_color(t.foreground))
            .when(k !== card.column && !busy, (el) => el.cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.todoAct("move", card, [k], cx)))
            .when(k !== card.column && busy, (el) => el.text_color(t.dim))
            .child(TODO_TITLE[k])))
          .child(div().flex_1())
          .child(div().id("tm-rm").px(7).h(24).flex().items_center().rounded(4).text_size(11.5).text_color(t.dim)
            // Two clicks: the first asks.
            .when(this.confirmRm === card.id, (el) => el.text_color(t.blocked).bg(t.blocked + "1f"))
            .when(!busy, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.blocked)).on_click((_e, cx) => {
              if (this.confirmRm === card.id) { this.confirmRm = null; this.todoAct("rm", card, [], cx); } else { this.confirmRm = card.id; cx.notify(); }
            }))
            .child(this.busy === "todo:rm" ? "Deleting…" : this.confirmRm === card.id ? `Delete T${card.id}?` : "Delete")))
        .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.note))))
      .child(v_flex().px(16).py(12).gap(10).text_size(12.5)
        .when(Boolean(card.body?.trim()), (el) => el.child(TextView.markdown(`tb${card.id}`, card.body).selectable()))
        .when(!card.body?.trim() && !card.notes?.length, (el) => el.child(div().text_color(t.dim).child("No details yet. The agent adds notes as it goes.")))
        .when(Boolean(card.notes?.length), (el) => el.child(div().pt(4).text_size(11.5).font_medium().text_color(t.muted).child("Notes"))
          .children([...card.notes].reverse().map((n, i) => v_flex().id(`tn${i}`).gap(2).pt(6).border_t(1).border_color(t.border)
            .child(div().text_size(11).text_color(t.dim).child(`${n.by ? nameOf(n.by) : "you"} · ${ago(n.at)}`))
            .child(div().text_size(12.5).text_color(n.text.startsWith("Blocked:") ? t.blocked : t.foreground).child(n.text))))));
  }

  cardView(t, card) {
    const agent = this.agentFor(card.number);
    const wt = this.worktreeFor(card.number);
    const brief = this.briefs.get(card.number);
    const pr = card.pulls?.[0];
    const meta = [COLUMN[card.column], card.priority !== "normal" ? card.priority : null, card.assignees?.length ? card.assignees.map((a) => `@${a}`).join(" ") : "unassigned",
      pr ? `PR #${pr.number} ${pr.merged ? "merged" : pr.state}${pr.checks ? `, checks ${pr.checks}` : ""}` : null].filter(Boolean).join(" · ");
    return v_flex().id("m-card").flex_1().min_h(0).overflow_y_scrollbar()
      .child(v_flex().px(16).pt(4).pb(14).gap(8).border_b(1).border_color(t.border)
        .child(div().text_size(15).font_medium().text_color(t.foreground)
          .child(`${card.title}`))
        .child(div().text_size(12).text_color(t.muted).child(`#${card.number} · ${meta}`))
        .when(Boolean(agent), (el) => el.child(h_flex().pt(4).gap(8).items_center()
          .child(h_flex().flex_1().h(28).px(10).gap(8).items_center().rounded(4).border_1().border_color(t.border)
            .child(this.mark(t, card, agent)).child(div().text_size(12.5).text_color(agent.status === "blocked" ? t.blocked : t.foreground).child(STATUS[agent.status])))
          .when(Boolean(this.progressLine(agent)), (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child(this.progressLine(agent))))
          .child(this.button("m-go", "Go to it", t, "primary", () => run("agent.focus", { terminal: agent.terminal })))))
        .when(!agent && card.column !== "done" && !(this.pending?.n === card.number) && !["running", "error"].includes(wt?.setup?.state) && !wt?.pr?.merged, (el) => el.child(div().pt(4).child(
          this.button("m-start", this.busy === "start" ? "Starting…" : wt ? "Start a Claude in its worktree" : "Start a Claude in a new worktree", t, "primary", (cx) => this.start(card, cx), Boolean(this.busy)))))
        .when(Boolean(wt?.setup) && !agent, (el) => el.child(this.jobView(t, "m-setup", wt.setup, "Setup", [
          this.button("m-setup-retry", this.busy === "setup" ? "Running…" : "Retry setup", t, "plain", (cx) => this.retrySetup(card, wt, cx), Boolean(this.busy)),
          this.button("m-setup-skip", "Start anyway", t, "primary", (cx) => this.startAnyway(card, wt, cx), Boolean(this.busy))]))
          .when(wt.setup.state === "running", (el) => el.child(div().text_size(11.5).text_color(t.dim).child("Its Claude starts when setup finishes. You can leave this card."))))
        .when(Boolean(this.done), (el) => el.child(div().text_size(12).text_color(t.done).child(this.done)))
        .when(Boolean(this.accepts[card.number]), (el) => el.child(this.jobView(t, "m-accept", this.accepts[card.number], "Accept", [
          this.button("m-accept-retry", "Run again", t, "plain", (cx) => cx.spawn(async (cx) => {
            try { await this.feed("accept", this.folder, String(card.number)); this.accepts[card.number] = { state: "running", at: Date.now(), command: this.repoSettings?.accept }; } catch (e) { this.note = String(e?.message ?? e); }
            cx.notify();
          }), Boolean(this.busy))])))
        .when(!agent && !wt && card.column !== "done", (el) => el.child(div().text_size(11.5).text_color(t.dim)
          .child("Claims the card. Claude asks once whether to trust the new folder; answer it in its tab.")))
        .when(Boolean(wt), (el) => el.child(h_flex().gap(6).items_center()
          .child(svg(icon("branch")).size(13).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().font_family("monospace").text_size(11.5).text_color(t.muted).child(wt.branch))
          .when(!same(this.folder, wt.path), (el) => el.child(this.button("m-wt-open", "Open", t, "plain", () => this.openWorktree(wt))))
          .child(this.button("m-wt-rm", this.busy === "remove" ? "Removing…" : "Remove", t, "plain", (cx) => this.removeWorktree(wt, cx),
            Boolean(this.busy) || Boolean(agent) || same(this.folder, wt.path)))))
        .when(Boolean(wt) && (Boolean(agent) || same(this.folder, wt.path)), (el) => el.child(div().text_size(11.5).text_color(t.dim)
          .child(agent ? "Remove it once its Claude is closed." : "You're in it: remove it from the repo's space.")))
        .when(Boolean(wt), (el) => el.child(this.reviewView(t, wt, agent)).child(this.mergeView(t, card, wt)))
        .child(h_flex().pt(2).gap(2).flex_wrap().items_center()
          .children(COLUMNS.map(([k, label]) => div().id(`mv-${k}`).px(7).h(24).flex().items_center().rounded(4).text_size(11.5)
            .when(k === card.column, (el) => el.bg(t.selected).text_color(t.foreground))
            .when(k !== card.column && !this.busy, (el) => el.cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.move(card, k, cx)))
            .when(k !== card.column && Boolean(this.busy), (el) => el.text_color(t.dim))
            .child(this.busy === `move:${k}` ? "Moving…" : label))))
        .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.note))))
      .child(div().px(16).py(12).text_size(12.5)
        .child(brief === null || brief === undefined ? div().text_color(t.dim).child("Reading the brief…")
          : brief.error ? div().text_color(t.blocked).child(`Couldn't read the brief: ${brief.error}`)
          : TextView.markdown(`mb${card.number}`, brief).selectable()));
  }

  render() {
    const t = theme();
    const card = this.selected !== null && Object.values(this.board?.columns ?? {}).flat().find((c) => c.number === this.selected);
    const todo = !card && this.todoSel != null && this.todos?.cards.find((c) => c.id === this.todoSel);
    const settings = this.settingsOpen && !card && !todo && Boolean(this.board);
    const head = card || todo || settings
      ? h_flex().h(42).flex_none().px(8).gap(6).items_center()
        .child(h_flex().id("m-back").h(26).px(6).gap(4).items_center().rounded(4).cursor_pointer().text_size(12.5).text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { this.confirmRm = null; this.open(null, cx); })
          .child(svg(icon("chevron-left")).size(14)).child("Board"))
        .child(div().flex_1())
        .when(Boolean(card), (el) => el.child(this.iconButton("m-web", "external", t, () => this.openOnWeb(card))))
      : h_flex().h(42).flex_none().pl(16).pr(8).gap(8).items_center()
        .child(div().flex_none().text_size(13).font_medium().text_color(t.foreground).child("Mission"))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.board?.repo ?? this.todos?.name ?? ""))
        .when(Boolean(this.board), (el) => el.child(this.iconButton("m-gear", "settings", t, (cx) => this.openSettings(cx))))
        .child(this.iconButton("m-refresh", "refresh", t, (cx) => this.load(cx), this.loading || !this.folder));
    return v_flex().id("kodr-mission").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(head)
      .child(card ? this.cardView(t, card) : todo ? this.todoCardView(t, todo) : settings ? this.settingsView(t) : this.boardView(t))
      .when(!card && !todo && !settings && Boolean(this.folder), (el) => el.child(h_flex().h(26).flex_none().px(16).items_center().border_t(1).border_color(t.border)
        .text_size(11).text_color(t.dim).child(this.loading ? "Refreshing…" : [this.todos ? `${this.todos.cards.length} todos` : null,
          this.board ? `${Object.values(this.board.columns).flat().length} issues · updated ${ago(this.at)}` : null].filter(Boolean).join(" · "))));
  }
}
