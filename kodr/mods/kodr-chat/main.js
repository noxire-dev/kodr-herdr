// Chat view of a Claude Code terminal started with Kodr's settings, laid out like Zed's agent panel.
// Rows come from the session's transcript (feed/kodr-feed.mjs); messages, slash commands and keys
// go to the terminal with hc, so the terminal and the chat are two views of one session.
// Permission cards answer the PermissionRequest hook. Opened by kodr-pane's switch (props.terminal).
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, TextView, ScrollHandle, InputState, Input } from "gpui-base";
import { focused, props, home, appHome, readTextFile, writeTextFile, exec, hc, agents, panes, terminals, notify, run, setShared, shared, theme, settings, window, nextCommand } from "herdr";
import { icon, diffView, button, questionCard, planCard, todosPanel } from "./cards.js";
import { yapRow, yapStrip } from "./yap.js";
import { crewRow } from "./crew.js";
import { splitBlocks, fenced } from "./blocks.js";
import { turns, summary } from "./turns.js";
import { hits as findHits, findRe, markMarkdown, countMarks, MARK } from "./find.js";
import { ts, zoom, chatFont, codeFont, SIZES, FONTS } from "./size.js";
import { draftOf, clearKeys } from "./draft.js";

const root = () => `${home()}/.kodr-herdr`;
const termDir = (terminal) => `${root()}/t/${terminal}`;
const ALLOW = { behavior: "allow" };
const DENY = { behavior: "deny", message: "The person declined this in the chat." };

// Claude Code's permission modes, as its status line names them; Shift+Tab cycles the available ones.
const MODES = [
  { id: "manual", label: "Ask", desc: "Asks before edits and commands" },
  { id: "acceptEdits", label: "Accept edits", desc: "Edits files without asking; asks before commands" },
  { id: "auto", label: "Auto", desc: "Approves safe actions itself; asks before risky ones" },
  { id: "plan", label: "Plan", desc: "Reads and plans; changes nothing" },
  { id: "bypass", label: "Bypass", desc: "Never asks. Only in a repo you trust" },
];
const modeOf = (id) => MODES.find((m) => m.id === id);
const MODE_SCREEN = [[/bypass permissions on/i, "bypass"], [/accept edits on/i, "acceptEdits"], [/plan mode on/i, "plan"], [/auto mode on/i, "auto"], [/manual mode on/i, "manual"]];
const TOOL_ICON = { Read: "file", Write: "pencil", Edit: "pencil", MultiEdit: "pencil", NotebookEdit: "pencil",
  Bash: "terminal", PowerShell: "terminal", Grep: "search", Glob: "search", WebFetch: "globe", WebSearch: "globe",
  Task: "agent", Agent: "agent", TodoWrite: "list", TaskCreate: "list", TaskUpdate: "list", TaskList: "list", Skill: "sparkle", AskUserQuestion: "at", ExitPlanMode: "list" };
const TOOL_VERB = { Read: "Read", Write: "Write", Edit: "Edit", MultiEdit: "Edit", Bash: "Run", PowerShell: "Run",
  Grep: "Search", Glob: "Find", WebFetch: "Fetch", WebSearch: "Search the web", Task: "Agent", Agent: "Agent",
  TodoWrite: "Update plan", TaskCreate: "Add task", TaskUpdate: "Update task", TaskList: "List tasks", Skill: "Skill", AskUserQuestion: "Question", ExitPlanMode: "Plan" };
// Per-space notification levels, as mod/kodr-pane/attention.js names them (a mod can't import another mod's files).
const NOTIFY_LEVELS = [["all", "All"], ["needs", "Needs me"], ["off", "Off"]];
const MAX_W = 960;
const FADE_MS = 220;

// "claude-haiku-5-5" → "Haiku 5.5"
// Tools whose object is a path, a pattern or a command: drawn in the code font.
const CODE_OBJECT = new Set(["Bash", "Read", "Edit", "MultiEdit", "Write", "Glob", "Grep", "NotebookEdit", "LS", "PowerShell"]);

// Text that must read on the chat's background (4.5:1): the theme's dim, lifted toward the foreground until it does.
function readable(c, fg, bg) {
  const hex = /^#[0-9a-f]{6}/i;
  if (![c, fg, bg].every((x) => hex.test(x ?? ""))) return c;
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const lum = (v) => {
    const [r, g, b] = v.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = rgb(c), f = rgb(fg), lb = lum(rgb(bg));
  for (let k = 0; k <= 1; k += 0.05) {
    const m = a.map((x, i) => Math.round(x + (f[i] - x) * k)), l = lum(m);
    if ((Math.max(l, lb) + 0.05) / (Math.min(l, lb) + 0.05) >= 4.5) return "#" + m.map((x) => x.toString(16).padStart(2, "0")).join("");
  }
  return fg;
}

const modelName = (m) => {
  if (!m) return "Model"; // none in the transcript yet; a click still opens /model
  const [fam, ...v] = m.replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  return `${fam[0].toUpperCase()}${fam.slice(1)} ${v.join(".")}`.trim();
};

export default class KodrChat extends View {
  init(_props, cx) {
    this.target = null;
    this.view = null;
    this.error = null;
    this.open = new Set();
    this.ticks = 0;
    this.images = []; // pasted images now in Claude's input: { path } for the preview
    this.menu = null; // { kind: "/" | "$" | "@", start, end, items, index }
    this.modeMenu = false;
    this.modeBusy = null; // the mode being switched to
    this.modeNote = null; // why the last switch didn't land
    this.qa = new Map(); // ask id → { sel: Map(question → Set(label)), other: Map(question → InputState) }
    this.pending = []; // sent, not in the transcript yet: { text, at }
    this.todosOpen = true;
    this.hover = null; // the reply row under the pointer (its Quote button)
    this.copied = null; // the Copy button that just copied, for its "Copied" tick
    this.follow = true; // keep the newest row in view; off while the person has scrolled up to read
    this.away = 0; // how far up they've scrolled, in pixels, as the wheel reported it
    this.unseen = false; // rows arrived while they were scrolled up
    this.newFrom = Infinity; // rows from this index just arrived and fade in from bornAt (Deft's arrival)
    this.bornAt = 0;
    this.typing = false; // the message box has the keyboard
    this.yap = null; // the YAP daemon's view of this repo (feed/kodr-yap.mjs peers), null while unknown or down
    this.yapOpen = false;
    this.answering = null; // { key, to, re, input, error }: answering a YAP message
    this.data = { commands: [], files: [] };
    // Find (Ctrl+F): findQ is the query in use (typing settles for 150 ms: a redraw rebuilds every row), findList
    // the rows holding it, oldest first, findAt the current one, seekRow the row to bring into view.
    this.findOpen = false; this.findQ = ""; this.findList = []; this.findAt = -1; this.findKey = null; this.seekRow = null;
    this.findBox = InputState.new({ placeholder: "Find in this chat" });
    this.findKeys = cx.focus_handle();
    this.rootKeys = cx.focus_handle();
    this.findBox.on("change", (_e, cx) => {
      const gen = (this.findGen = (this.findGen ?? 0) + 1);
      cx.timer.after(150, (cx) => { if (gen === this.findGen) { this.findQ = this.findBox.value().trim(); cx.notify(); } });
    });
    // From the newest hit up: Enter goes to the older one, Shift+Enter the newer.
    this.findBox.on("submit", (e, cx) => this.findStep(e?.shift ? 1 : -1, cx));
    this.scroll = ScrollHandle.new();
    this.menuScroll = ScrollHandle.new();
    // The textarea takes ↑ ↓ Tab and Escape for itself (caret, indent): while a / $ @ menu is open, bindings of ours,
    // matched at the textarea's own depth and added after its own, win them.
    try {
      cx.bind_keys([["up", "kodr_menu_up"], ["down", "kodr_menu_down"], ["tab", "kodr_menu_pick"], ["escape", "kodr_menu_close"]]
        .map(([keystroke, action]) => ({ keystroke, action, context: "KodrMenu > Input" })));
    } catch {}
    this.input = TextareaState.new({ placeholder: "Message Claude — / commands, $ skills, @ files" });
    this.input.set_auto_grow(2, 10);
    this.input.on("change", (_e, cx) => this.changed(cx));
    this.mods = {};
    this.prevValue = "";
    this.input.on("paste_other", (_e, cx) => this.pasteImage(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    cx.spawn(async (cx) => {
      this.config = JSON.parse((await readTextFile(`${root()}/config.json`).catch(() => null)) ?? "null");
      this.tick(cx);
    });
    cx.timer.every(1000, (cx) => this.tick(cx));
    // Keys (or herdr-app do): "kodr-chat.modes" opens the permission menu; "kodr-chat.mode-plan"
    // (mode-manual, -acceptEdits, -auto, -bypass) switches straight to that mode.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "fork-toggle") this.toggleFork(cx);
        // Draws every hover-only control at once, for screenshots (nobody hovers in one): herdr-app do kodr-chat.hovers
        else if (c === "hovers") { this.hovers = !this.hovers; cx.notify(); }
        else if (c === "notify-toggle") this.toggleNotify(cx);
        // The look from a key or script: kodr-chat.size-<s|m|l>, kodr-chat.font-<zed|default|system|mono>.
        else if (c.startsWith("size-") && SIZES.some(([k]) => k === c.slice(5))) { setShared("kodr.chat.size", c.slice(5)); cx.notify(); }
        else if (c.startsWith("font-") && FONTS.some(([k]) => k === c.slice(5))) { setShared("kodr.chat.font", c.slice(5)); cx.notify(); }
        // Ctrl+F's bar from a script, in the chat of one terminal only (never every open chat):
        // kodr-chat.find:<terminal>:<query>, find-next:<terminal>, find-prev:<terminal>, find-close:<terminal>.
        // The composer from a script, for screenshots of its menus: kodr-chat.compose:<terminal>:<text>, menu-down:<terminal>.
        else if (/^(compose|menu-down):/.test(c)) {
          const [verb, term, ...text] = c.split(":");
          if (term !== this.target) continue;
          if (verb === "menu-down") this.menuMove(1, cx);
          else { const v = text.join(":"); this.input.set_value(v); this.input.set_selected_range({ start: v.length, end: v.length }); this.prevValue = v; this.complete(cx); }
        }
        else if (/^find(-next|-prev|-close)?:/.test(c)) {
          const [verb, term, ...q] = c.split(":");
          if (term !== this.target) continue;
          if (verb === "find") this.openFind(cx, q.join(":"));
          else if (verb === "find-close") this.closeFind(cx);
          else this.findStep(verb === "find-next" ? 1 : -1, cx);
        }
        else if (c === "modes") { this.modeMenu = !this.modeMenu; this.menu = null; cx.notify(); }
        else if (c.startsWith("mode-") && modeOf(c.slice(5))) this.setMode(c.slice(5), cx);
      }
    });
  }

  status() {
    return agents().find((a) => a.address === this.target)?.status ?? "idle";
  }

  // A chat opened by the pane switch shows its own agent; otherwise it follows focus.
  tick(cx) {
    if (!this.config) return;
    const t = props()?.terminal ?? focused()?.terminal;
    this.ticks++;
    if (t && t !== this.target) {
      cx.spawn(async (cx) => {
        if (!(await readTextFile(`${termDir(t)}/session.json`).catch(() => null))) return;
        if (!props()?.terminal && focused()?.terminal !== t) return;
        this.target = t;
        this.view = null;
        this.refresh(cx);
        this.loadCompletions(cx);
      });
      return;
    }
    const busy = ["working", "blocked"].includes(this.status());
    if (this.target && (busy || this.dirty || this.ticks % 4 === 0)) this.refresh(cx);
    if (this.view && this.ticks % 5 === 1) this.loadPeers(cx);
  }

  refresh(cx) {
    if (this.loading) { this.dirty = true; return; }
    this.loading = true;
    this.dirty = false;
    const t = this.target;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-feed.mjs`, t]);
        if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "the feed failed");
        const next = JSON.parse(r.stdout);
        if (!next.none && this.target === t) {
          next.mode ??= this.view?.mode ?? null; // a dialog hides the status line: keep the last mode
          const last = JSON.stringify(next.rows.at(-1)), prev = JSON.stringify(this.view?.rows?.at(-1));
          if (last !== prev || next.rows.length !== this.view?.rows?.length) { if (this.follow) this.stick = true; else this.unseen = true; }
          const before = this.view?.session === next.session ? this.view.rows.length : null;
          if (before != null && next.rows.length > before) {
            this.newFrom = before;
            this.bornAt = Date.now();
            // Driven here, not by a GPUI transition: it always ends fully drawn, even if no frame came in between.
            cx.spawn(async (cx) => {
              while (Date.now() - this.bornAt < FADE_MS) { await cx.sleep(16); cx.notify(); }
              if (this.newFrom === before) this.newFrom = Infinity;
              cx.notify();
            });
          }
          this.view = next;
          if (next.draft && this.here()) this.adopt(cx);
          const draft = shared("kodr.fork.draft");
          if (draft?.session === next.session) { setShared("kodr.fork.draft", null); if (!this.input.value().trim()) this.input.set_value(draft.text); }
          this.error = null;
          const said = new Set(next.rows.filter((r) => r.kind === "user").map((r) => r.text.trim()));
          this.pending = this.pending.filter((p) => !said.has(p.text) && Date.now() - p.at < 120_000);
        }
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Who else works in this repo, from the YAP daemon (hidden when it isn't running).
  loadPeers(cx) {
    const v = this.view;
    if (!v?.cwd || this.yapLoading) return;
    this.yapLoading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-yap.mjs`, "peers", v.cwd, (v.session ?? "").slice(0, 8)]);
        const y = JSON.parse(r.stdout || "{}");
        this.yap = y.ok ? y : null;
      } catch { this.yap = null; }
      finally { this.yapLoading = false; cx.notify(); }
    });
  }

  startReply(key, r, cx) {
    const input = InputState.new({ placeholder: r.type === "question" || r.type === "blocker" ? `Your answer to ${r.from}` : `Reply to ${r.from}` });
    input.on("change", (_e, cx) => cx.notify());
    input.on("submit", (_e, cx) => this.sendReply(cx));
    this.answering = { key, to: r.from, re: r.id ?? null, input, error: null };
    input.focus();
    cx.notify();
  }

  // Through the daemon, as the person at this machine (YAP marks it as a local sender).
  sendReply(cx) {
    const rp = this.answering, text = rp?.input.value().trim();
    if (!rp || !text) return;
    const args = [`${this.config.root}/feed/kodr-yap.mjs`, "say", this.view.cwd, rp.to, ...(rp.re ? ["--re", rp.re] : []), text];
    cx.spawn(async (cx) => {
      const r = await exec(this.config.node, args).catch((e) => ({ stdout: JSON.stringify({ error: String(e) }) }));
      let res = {};
      try { res = JSON.parse(r.stdout); } catch {}
      if (res.ok) this.answering = null;
      else rp.error = res.down ? "The yap daemon isn't running." : /^no live session/.test(res.error ?? "") ? `${rp.to} has ended; yap only reaches running sessions.` : res.error ?? "yap didn't take the message.";
      cx.notify();
    });
  }

  loadCompletions(cx) {
    const t = this.target;
    cx.spawn(async (cx) => {
      const r = await exec(this.config.node, [`${this.config.root}/feed/kodr-complete.mjs`, t]).catch(() => null);
      try { if (r?.code === 0 && this.target === t) this.data = JSON.parse(r.stdout); } catch {}
      cx.notify();
    });
  }

  // The / $ or @ word under the cursor opens a menu of commands, skills or files. / only counts at the start.
  complete(cx) {
    const text = this.input.value(), at = this.input.selected_range().start;
    const before = text.slice(0, at), m = /(^|\s)([/@$])([^\s]*)$/.exec(before);
    if (!m || (m[2] === "/" && before.trim() !== m[2] + m[3])) { this.menu = null; cx.notify(); return; }
    const q = m[3].toLowerCase(), kind = m[2];
    // / lists everything Claude's own / menu does (skills too); $ only the skills.
    const pool = kind === "@" ? this.data.files.map((f) => ({ label: f, desc: "", tag: "" }))
      : this.data.commands.filter((c) => kind === "/" || c.kind === "skill").map((c) => ({ label: c.name, desc: c.desc, tag: c.kind }));
    // Starts-with first (a file's name, a plugin skill's name after its "plugin:"), then the name contains it, then the
    // description does. The list scrolls.
    const starts = [], has = [], about = [];
    for (const it of pool) {
      const l = it.label.toLowerCase(), base = kind === "@" ? l.split("/").pop() : l.split(":").pop();
      if (base.startsWith(q) || l.startsWith(q)) starts.push(it);
      else if (l.includes(q)) has.push(it);
      else if (kind !== "@" && q.length > 2 && it.desc.toLowerCase().includes(q)) about.push(it);
    }
    const items = [...starts, ...has, ...about].slice(0, 200);
    // Nothing matches: the menu stays, saying so (keys pass through to the box).
    this.menu = { kind, start: at - m[3].length - 1, end: at, items, index: 0 };
    this.menuSeek = true;
    cx.notify();
  }

  menuMove(step, cx) {
    if (!this.menu?.items.length) return;
    const n = this.menu.items.length;
    this.menu.index = (this.menu.index + step + n) % n;
    this.menuSeek = true;
    cx.notify();
  }

  accept(cx) {
    if (!this.menu?.items.length) { this.menu = null; cx.notify(); return; }
    const { kind, start, end, items, index } = this.menu;
    const text = this.input.value(), insert = `${kind}${items[index].label} `;
    this.input.set_value(text.slice(0, start) + insert + text.slice(end));
    const caret = start + insert.length;
    this.input.set_selected_range({ start: caret, end: caret });
    this.menu = null;
    cx.notify();
  }

  insert(text, cx) {
    const v = this.input.value(), at = this.input.selected_range().start;
    const pad = at > 0 && !/\s$/.test(v.slice(0, at)) ? " " : "";
    this.input.set_value(v.slice(0, at) + pad + text + v.slice(at));
    const caret = at + pad.length + text.length;
    this.input.set_selected_range({ start: caret, end: caret });
    this.input.focus();
    this.complete(cx);
  }

  // The textarea handles Enter itself (a newline), so a send shows up as a newline typed at the
  // cursor: Enter sends (Ctrl+Enter stops the turn first), Shift+Enter keeps the newline, and with
  // a menu open Enter picks the highlighted item.
  changed(cx) {
    const v = this.input.value(), prev = this.prevValue, at = this.input.selected_range().start;
    this.prevValue = v;
    const enter = v.length === prev.length + 1 && v[at - 1] === "\n" && v.slice(0, at - 1) + v.slice(at) === prev;
    if (!enter || this.mods.shift) { this.complete(cx); return; }
    this.input.set_value(prev);
    this.input.set_selected_range({ start: at - 1, end: at - 1 });
    this.prevValue = prev;
    if (this.menu) this.accept(cx);
    else this.send(cx, Boolean(this.mods.control || this.mods.platform));
  }

  onKey(e, cx) {
    const k = e.keystroke;
    this.mods = e.modifiers ?? this.mods;
    if (k === "escape" && this.modeMenu) { this.modeMenu = false; cx.stop_propagation(); cx.notify(); return; }
    if (this.menu?.items.length) {
      if (k === "up" || k === "down") { this.menuMove(k === "up" ? -1 : 1, cx); cx.stop_propagation(); return; }
      if (k === "tab" || k === "enter") { this.accept(cx); cx.stop_propagation(); return; }
      if (k === "escape") { this.menu = null; cx.stop_propagation(); cx.notify(); return; }
    }
    // GPUI spells Ctrl on Windows and Linux as "cmd" too.
    if (k === "cmd-enter" || k === "ctrl-enter") { this.send(cx, true); cx.stop_propagation(); return; }
    if (k === "enter") { this.send(cx); cx.stop_propagation(); }
  }

  // Claude reads a pasted image from the clipboard itself: forward the paste to its terminal.
  // A copy is kept for the preview: mods draw images only from herdr's folder. (Windows reads the
  // clipboard with PowerShell; elsewhere the preview is a plain chip.)
  pasteImage(cx) {
    const t = this.target;
    if (!t) return;
    const win = window()?.platform === "windows";
    const rel = `data/kodr-chat/img/paste-${Date.now()}.png`;
    const shot = { path: null };
    this.images.push(shot);
    cx.notify();
    cx.spawn(async (cx) => {
      if (win) {
        const file = `${appHome()}/${rel}`.replace(/\//g, "\\");
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $i = [Windows.Forms.Clipboard]::GetImage(); if ($i) { New-Item -ItemType Directory -Force -Path (Split-Path '${file}') | Out-Null; $i.Save('${file}', [Drawing.Imaging.ImageFormat]::Png); 'ok' }`;
        const r = await exec("powershell", ["-NoProfile", "-STA", "-Command", ps]).catch(() => null);
        if (r?.stdout.includes("ok")) { shot.path = rel; cx.notify(); }
      }
      await hc(["keys", t, win ? "alt+v" : "ctrl+v"]);
    });
  }

  drop(paths, cx) {
    const cwd = (this.view?.cwd ?? "").replace(/\\/g, "/").toLowerCase();
    const refs = paths.map((p) => {
      const f = p.replace(/\\/g, "/");
      const rel = cwd && f.toLowerCase().startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f;
      return `@${/\s/.test(rel) ? `"${rel}"` : rel}`;
    });
    this.insert(refs.join(" ") + " ", cx);
  }

  // $skill is Kodr's shorthand: at the start it runs the skill (/skill), elsewhere it names it.
  skills(text) {
    const known = new Set(this.data.commands.filter((c) => c.kind === "skill").map((c) => c.name));
    return text.replace(/(^|\s)\$([\w:.-]+)/g, (all, pre, name, at) =>
      !known.has(name) ? all : at === 0 && !pre ? `/${name}` : `${pre}the ${name} skill`);
  }

  // While Claude works, Enter steers (stops the current step, sends at once) or queues (Claude reads
  // it after its current step), as the Queue | Steer switch says; Ctrl+Enter does the other one.
  steersByDefault() {
    return (shared("kodr.chat.enter") ?? "steer") === "steer";
  }

  // flip: Ctrl+Enter, the opposite of the switch.
  send(cx, flip = false) {
    const now = this.steersByDefault() !== flip;
    const text = this.skills(this.input.value().trim()), t = this.target;
    if (!t || (!text && !this.images.length)) return;
    const busy = this.status() === "working";
    this.input.set_value("");
    this.menu = null;
    if (text) this.pending.push({ text, at: Date.now(), queued: busy && !now });
    this.images = [];
    this.jump(cx);
    cx.spawn(async (cx) => {
      await this.adopt(cx);
      if (now && busy) await hc(["interrupt", t]);
      await (text ? hc(["send", t, text]) : hc(["keys", t, "enter"]));
      this.dirty = true;
      cx.notify();
    });
  }

  // The person is in this chat: its pane is focused and covers the terminal (zoomed, or the terminal isn't in the tab).
  here() {
    const t = this.target, mine = terminals().find((x) => x.address === t)?.labels?.["kodr.chat"];
    const p = mine && panes().find((x) => x.pane === mine);
    return Boolean(p?.focused && (p.zoomed || !panes().some((x) => x.terminal === t && x.tab === p.tab)));
  }

  // Text typed in the terminal and not sent: hc send would wait on it (up to a minute after the last key), then paste
  // the chat's message after it. It moves into the chat's box instead, ahead of what's there, and out of the terminal
  // (Ctrl+Y there brings it back). Left alone if the terminal didn't let go of it.
  async adopt(cx) {
    const t = this.target;
    if (!t || this.adopting) return false;
    this.adopting = true;
    try {
      const read = async () => draftOf((await hc(["read", t]).catch(() => null))?.stdout ?? "");
      const d = await read();
      if (!d.text) return false;
      await hc(["keys", t, ...clearKeys(d.lines)]);
      if ((await read()).text) return false;
      const v = this.input.value().trim(), next = v ? `${d.text}\n${v}` : d.text;
      this.prevValue = next;
      this.input.set_value(next);
      this.input.set_selected_range({ start: next.length, end: next.length });
      notify({ title: "Kodr", body: "Your unsent text from the terminal is in the chat box now.", level: "info" });
      cx.notify();
      return true;
    } finally { this.adopting = false; }
  }

  // The PermissionRequest hook prints this file as its decision.
  answer(id, decision, cx) {
    const t = this.target;
    const out = JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
    cx.spawn(async (cx) => {
      await writeTextFile(`${termDir(t)}/asks/${id}.ans.json`, out, null).catch(() => {});
      this.dirty = true;
      cx.notify();
    });
  }

  questionState(id) {
    if (!this.qa.has(id)) this.qa.set(id, { sel: new Map(), other: new Map() });
    return this.qa.get(id);
  }

  pickOption(id, qi, label, multi, cx) {
    const st = this.questionState(id), cur = st.sel.get(qi) ?? new Set();
    if (multi) { if (cur.has(label)) cur.delete(label); else cur.add(label); }
    else { cur.clear(); cur.add(label); }
    st.sel.set(qi, cur);
    cx.notify();
  }

  otherAnswer(id, qi, cx) {
    const st = this.questionState(id);
    const input = InputState.new({ placeholder: "Your answer" });
    input.on("change", (_e, cx) => cx.notify());
    st.other.set(qi, input);
    input.focus();
    cx.notify();
  }

  // As Claude's own prompt answers: { [question]: "label, label" or the typed answer }.
  answerQuestions(r, cx) {
    const st = this.questionState(r.ask.id), qs = r.detail?.questions ?? [], answers = {};
    qs.forEach((q, i) => {
      const typed = st.other.get(i)?.value().trim();
      answers[q.question] = typed || [...(st.sel.get(i) ?? [])].join(", ");
    });
    this.answer(r.ask.id, { behavior: "allow", updatedInput: { questions: qs, answers } }, cx);
  }

  keepPlanning(id, cx) {
    const note = this.input.value().trim();
    if (note) this.input.set_value("");
    this.answer(id, { behavior: "deny", message: note || "Keep planning; don't start yet." }, cx);
  }

  copy(key, text, cx) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === key) { this.copied = null; cx.notify(); } });
  }

  // A small "Copy" chip; "Copied" with a tick for a moment after a click.
  copyChip(key, text, t, bg) {
    const done = this.copied === key;
    return div().id(key).px(6).h(20).flex().flex_none().gap(4).items_center().rounded(4).border_1().border_color(t.border)
      .bg(bg).text_size(ts(12.5)).text_color(done ? t.foreground : t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.copy(key, text, cx))
      .child(svg(icon(done ? "check" : "copy")).size(12)).child(done ? "Copied" : "Copy");
  }

  // Quote a reply into the message box.
  quote(text, cx) {
    const q = text.trim().split("\n").slice(0, 6).map((l) => `> ${l}`).join("\n");
    this.insert(`${q}\n\n`, cx);
  }

  // The Review tab, on this session's latest turn.
  openReview() {
    setShared("kodr.review.select", { terminal: this.target, at: Date.now() });
    const tab = panes().find((p) => p.mod === "kodr-review")?.tab;
    if (tab) run("tab.select", { id: tab });
    else run("tab.new", { name: "Review", mod: "kodr-review" });
  }

  // Claude has no "set mode" input, only Shift+Tab: press it until its status line shows the target.
  setMode(id, cx) {
    const t = this.target;
    this.modeMenu = false;
    if (!t || id === this.view?.mode) { cx.notify(); return; }
    this.modeBusy = id;
    this.modeNote = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let now = null;
      for (let i = 0; i < MODES.length + 1 && now !== id; i++) {
        await hc(["keys", t, "shift+tab"]);
        await cx.sleep(350);
        const screen = (await hc(["read", t]).catch(() => null))?.stdout?.split("\n").slice(-4).join("\n") ?? "";
        now = MODE_SCREEN.find(([re]) => re.test(screen))?.[1] ?? "manual";
      }
      if (now !== id) this.modeNote = id === "bypass"
        ? "Bypass isn't on offer in this session. Start Claude with --allow-dangerously-skip-permissions."
        : `${modeOf(id)?.label ?? id} isn't available in this session.`;
      if (this.view) this.view.mode = now;
      this.modeBusy = null;
      this.dirty = true;
      cx.notify();
    });
  }

  // Ease-out from 0 to 1 over FADE_MS since the rows arrived.
  fade() {
    const p = Math.min(1, (Date.now() - this.bornAt) / FADE_MS);
    return 1 - (1 - p) ** 3;
  }

  // Back to the newest row, following again.
  jump(cx) {
    this.follow = true;
    this.away = 0;
    this.unseen = false;
    this.stick = true;
    cx.notify();
  }

  // The wheel moving up (positive y) stops following; back down to where it started follows again.
  wheel(e, cx) {
    this.away = Math.max(0, this.away + (e.delta?.y ?? 0));
    const follow = this.away < 4;
    if (follow === this.follow) return;
    this.follow = follow;
    if (follow) this.unseen = false;
    cx.notify();
  }

  interrupt(cx) {
    const t = this.target;
    cx.spawn(async () => { await hc(["interrupt", t]); });
  }

  toggle(key, cx) {
    if (this.open.has(key)) this.open.delete(key);
    else this.open.add(key);
    cx.notify();
  }

  // ---- find in chat

  openFind(cx, q = null) {
    this.findOpen = true;
    if (q != null) { this.findBox.set_value(q); this.findQ = q.trim(); }
    else this.findQ = this.findBox.value().trim();
    // What was searched last is kept, selected, so typing replaces it.
    this.findBox.set_selected_range({ start: 0, end: this.findBox.value().length });
    cx.timer.after(30, () => this.findBox.focus());
    cx.notify();
  }

  closeFind(cx) {
    this.findOpen = false; this.findQ = ""; this.findList = []; this.findAt = -1; this.findKey = null; this.seekRow = null;
    this.input.focus();
    this.jump(cx);
  }

  // -1: the older hit, 1: the newer (both wrap round). A query still settling is taken first.
  findStep(dir, cx) {
    const q = this.findBox.value().trim();
    if (q !== this.findQ) { this.findQ = q; cx.notify(); return; }
    const n = this.findList.length;
    if (!n) return;
    this.findAt = (this.findAt + dir + n) % n;
    this.seekRow = this.curRow();
    cx.notify();
  }

  // The hits, searched again only when the query or the rows changed. A new query goes to the newest hit;
  // new rows keep the current one. While a hit is shown the chat stops following new rows.
  findSync(rows) {
    if (!this.findOpen || !this.findQ) { this.findList = []; this.findAt = -1; this.findKey = null; return; }
    const base = `${this.findQ}|${this.view?.session}|`, key = base + rows.length;
    if (key === this.findKey) return;
    const same = this.findKey?.startsWith(base), was = this.findList[this.findAt];
    this.findKey = key;
    this.findList = findHits(rows, this.findQ);
    const k = same && was ? this.findList.findIndex((h) => h.i === was.i && h.k === was.k) : -1;
    this.findAt = k >= 0 ? k : this.findList.length - 1;
    if (!same && this.findAt >= 0) this.seekRow = this.curRow();
    if (this.findList.length) this.follow = false;
  }

  // findList holds every match ({ i: row, k: its kth mark there }); the current one's row:
  curRow() { return this.findList[this.findAt]?.i; }
  // A row with hits: MARK.current when it holds the current one (a tool line is marked whole), else MARK.hit; or null.
  markIn(i) {
    if (!this.findSet?.has(i)) return null;
    return this.curRow() === i ? MARK.current : MARK.hit;
  }
  // Markdown of row i with its hits marked, the current one brighter; start: marks in the row's earlier blocks.
  marked(md, i, start = 0) {
    if (!this.findSet?.has(i)) return md;
    return markMarkdown(md, this.findQ, MARK.hit, this.curRow() === i ? this.findList[this.findAt].k : -1, start);
  }

  findBar(t) {
    const n = this.findList.length;
    const count = !this.findQ ? "" : n ? `${this.findAt + 1} of ${n}` : "No matches";
    const step = (id, glyph, dir) => div().id(id).flex_none().size(24).flex().items_center().justify_center().rounded(4)
      .text_color(n ? t.muted : t.dim).when(n > 0, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click((_e, cx) => this.findStep(dir, cx)).child(svg(icon(glyph)).size(13));
    return h_flex().id("find-bar").track_focus(this.findKeys).h(40).flex_none().px(20).justify_center().border_b(1).border_color(t.border).bg(t.chrome)
      // Keys pass through here on their way up from the find box.
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") this.closeFind(cx);
        else if (k === "up") this.findStep(-1, cx);
        else if (k === "down" || k === "shift-enter") this.findStep(1, cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().w_full().max_w(MAX_W).gap(8).items_center().text_size(ts(13))
        .child(svg(icon("search")).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).h(26).px(8).flex().items_center().rounded(4).border_1().border_color(this.findQ && !n ? t.blocked : t.border)
          .bg(t.background).text_color(t.foreground).child(Input.new(this.findBox).w_full().text_size(ts(13.5))))
        .child(div().flex_none().min_w(64).text_color(n || !this.findQ ? t.muted : t.blocked).child(count))
        .child(step("find-prev", "chevron-up", -1))
        .child(step("find-next", "chevron-down", 1))
        .child(div().id("find-close").flex_none().size(24).flex().items_center().justify_center().rounded(4).cursor_pointer()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.closeFind(cx))
          .child(svg(icon("x")).size(12))));
  }

  // ---- drawing

  iconButton(id, name, t, onClick, active = false) {
    return div().id(id).size(24).flex().items_center().justify_center().rounded(4).cursor_pointer()
      .text_color(active ? t.foreground : t.muted).when(active, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => onClick(cx)).child(svg(icon(name)).size(14));
  }

  forkOn() { return shared("kodr.chat.fork") ?? true; }
  toggleFork(cx) { setShared("kodr.chat.fork", !this.forkOn()); cx.notify(); }
  // Read by kodr-toast: a Windows notification too, when Herdr isn't the window in front.
  notifyOn() { return shared("kodr.notify.desktop") ?? true; }
  toggleNotify(cx) { setShared("kodr.notify.desktop", !this.notifyOn()); cx.notify(); }

  // A new session holding everything before this message, resumed in a new tab; the message waits in
  // that chat's box to be edited and sent. The original conversation is left as it was.
  fork(r, cx) {
    const v = this.view;
    if (!v?.transcript || this.forking) return;
    this.forking = true;
    cx.spawn(async (cx) => {
      try {
        const res = JSON.parse((await exec(this.config.node, [`${this.config.root}/feed/kodr-fork.mjs`, v.transcript, r.uuid])).stdout || "{}");
        if (!res.ok) { this.forkError = res.error ?? "Couldn't fork"; return; }
        setShared("kodr.fork.draft", { session: res.session, text: r.text });
        run("tab.new", { name: "fork", folder: v.cwd, argv: [...(this.config.launch ?? ["claude"]), "--resume", res.session] });
      } catch (e) { this.forkError = String(e); }
      finally { this.forking = false; cx.notify(); }
    });
  }

  user(r, i, t, pending) {
    const canFork = !pending && Boolean(r.uuid) && i !== this.firstUser && this.forkOn();
    const over = canFork && (this.hover === `u${i}` || this.hovers);
    // Your message: a bubble on the right, the answer below it on the left (as T3 lays a thread out).
    // Fork sits in the free space left of the bubble, never over your text.
    return h_flex().id(`uw${i}`).w_full().justify_end().items_center().gap(8).mt(i ? 32 : 8).mb(12)
      .when(canFork, (el) => el.on_hover((h, cx) => { if (h) this.hover = `u${i}`; else if (this.hover === `u${i}`) this.hover = null; cx.notify(); }))
      .when(over, (el) => el.child(div().id(`fk${i}`).flex_none().px(8).h(24).flex().gap(5).items_center()
        .rounded(4).border_1().border_color(t.border).text_size(ts(12.5)).text_color(t.muted).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.fork(r, cx))
        .child(svg(icon("fork")).size(12)).child(this.forking ? "Forking…" : "Fork from here")))
      .child(v_flex().id(`u${i}`).max_w(720).px(16).py(12).gap(8)
      .rounded(8).border_1().border_color(t.border).bg(t.surface).text_color(t.foreground)
      .when(Boolean(r.images?.length), (el) => el.child(h_flex().gap(6).children(r.images.map((p, k) =>
        image(p).id(`ui${i}-${k}`).h(96).max_w(240).rounded(4).border_1().border_color(t.border)))))
      .when(Boolean(r.text), (el) => el.child(TextView.markdown(`um${i}`, this.marked(r.text, i)).selectable()))
      .when(Boolean(pending), (el) => el.child(div().text_size(ts(12.5)).text_color(t.dim)
        .child(pending.queued ? "Queued. Claude reads it after its current step." : "Sending…"))));
  }

  // Prose as markdown; each fenced code block drawn on its own with a Copy button that's always there.
  // Copy and Quote for the whole reply sit on the turn's end line, never over the text.
  reply(r, i, t) {
    let start = 0; // find numbers its marks across the reply's prose blocks
    return v_flex().id(`t${i}`).py(6).text_color(t.foreground)
      .children(splitBlocks(r.text).map((b, k) => {
        if (b.kind !== "md") return this.codeBlock(`cb${i}-${k}`, b, t);
        const md = this.marked(b.text, i, start);
        if (this.findSet?.has(i)) start += countMarks(b.text, this.findQ);
        return TextView.markdown(`md${i}-${k}`, md).selectable();
      }));
  }

  codeBlock(key, b, t) {
    return div().id(key).relative().my(6).when(b.indent > 0, (el) => el.ml(22))
      .child(TextView.markdown(`${key}m`, fenced(b)).selectable())
      .child(h_flex().absolute().top(12).right(6).gap(8).items_center()
        .when(Boolean(b.lang), (el) => el.child(div().text_size(ts(12)).text_color(t.dim).child(b.lang)))
        .child(this.copyChip(key, b.code, t, t.background)));
  }

  // What a tool line says: the verb, and for a few tools a better object than the raw input.
  label(r) {
    if (r.name === "TodoWrite") {
      const td = r.detail?.todos ?? [];
      return [`Update plan`, `${td.filter((x) => x.status === "completed").length} of ${td.length} done`];
    }
    if (r.name === "Task" || r.name === "Agent") return [r.detail?.agent ? `Agent · ${r.detail.agent}` : "Agent", r.summary];
    if (r.name === "AskUserQuestion") return ["Question", r.detail?.questions?.[0]?.question ?? ""];
    if (r.name === "ExitPlanMode") return ["Plan", "ready for review"];
    return [TOOL_VERB[r.name] ?? r.name, r.summary];
  }

  // A tool's open body: its change, the agent's brief, or its output.
  body(r, t, mono) {
    const card = v_flex().ml(26).mb(6).rounded(8).border_1().border_color(t.border).overflow_hidden();
    if (r.diff) return card.child(div().px(10).py(6).bg(t.chrome).border_b(1).border_color(t.border).font_family(mono).text_size(ts(13)).text_color(t.muted).child(r.summary))
      .child(diffView(r.diff, t, mono))
      .when(r.state === "error" && Boolean(r.output), (el) => el.child(div().px(10).py(8).border_t(1).border_color(t.border).font_family(mono).text_size(ts(13)).text_color(t.blocked).child(r.output)));
    if (r.name === "ExitPlanMode" && r.detail?.plan) return card.child(div().px(14).py(10).child(TextView.markdown(`pl-${r.id}`, r.detail.plan).selectable()));
    if ((r.name === "Task" || r.name === "Agent") && r.detail?.prompt) card.child(div().px(10).py(8).bg(t.chrome).border_b(1).border_color(t.border).text_size(ts(13)).text_color(t.muted).child(r.detail.prompt));
    else card.child(h_flex().px(10).py(6).gap(8).items_start().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().flex_1().min_w(0).font_family(mono).text_size(ts(13)).text_color(t.muted).child(r.summary))
      .when(Boolean(r.summary), (el) => el.child(this.copyChip(`ct-${r.id}`, r.summary, t, t.background))));
    return card.child(div().px(10).py(8).font_family(mono).text_size(ts(13)).text_color(r.state === "error" ? t.blocked : t.muted)
      .child(r.output || (r.state === "running" ? "Running…" : "No output")));
  }

  permissionCard(r, t, mono) {
    return v_flex().ml(26).my(6).rounded(8).border_1().border_color(t.blocked).bg(t.chrome).shadow_sm().overflow_hidden()
      .child(h_flex().px(12).py(9).gap(8).items_center()
        .child(svg(icon("shield")).size(14).flex_none().text_color(t.blocked))
        .child(div().flex_1().text_size(ts(13.5)).text_color(t.foreground).child(`Allow ${TOOL_VERB[r.name] ?? r.name}?`)))
      .child(r.diff
        ? v_flex().border_t(1).border_color(t.border).child(div().px(10).py(6).font_family(mono).text_size(ts(13)).text_color(t.muted).child(r.summary)).child(diffView(r.diff, t, mono))
        : div().px(12).pb(10).font_family(mono).text_size(ts(13)).text_color(t.muted).child(r.summary))
      .child(h_flex().px(12).py(8).gap(6).items_center().border_t(1).border_color(t.border)
        .child(button(`allow-${r.id}`, "Allow", t, "primary", (cx) => this.answer(r.ask.id, ALLOW, cx)))
        .child(button(`deny-${r.id}`, "Deny", t, "plain", (cx) => this.answer(r.ask.id, DENY, cx)))
        .child(div().flex_1())
        .child(this.terminalHint(t)));
  }

  // "or answer in the terminal", on the first waiting card only (render resets it).
  terminalHint(t) {
    if (this.hinted) return div();
    this.hinted = true;
    return div().text_size(ts(12.5)).text_color(t.dim).child("or answer in the terminal");
  }

  tool(r, t) {
    const asking = r.ask?.state === "pending";
    const mark = this.markIn(r._i);
    const open = this.open.has(r.id) || (mark === MARK.current && !findRe(this.findQ).test(r.summary ?? ""));
    const mono = codeFont();
    const [verb, object] = this.label(r);
    const state = asking ? ["Needs you", t.blocked] : r.state === "running" ? ["Running", t.working]
      : r.state === "error" && !r.ask?.declined ? ["Failed", t.blocked]
      : r.state === "stopped" && !r.ask ? ["Stopped", t.dim] : null;
    const note = r.ask?.state === "done" ? r.ask : null;
    const special = asking && (r.name === "AskUserQuestion" || r.name === "ExitPlanMode");
    return v_flex().id(`tool-${r.id}`)
      .child(h_flex().id(`tl-${r.id}`).h(30).gap(8).items_center().px(4).rounded(4).cursor_pointer().text_size(ts(13.5))
        // A hit tints the line (the solid current colour hides its text); the current one gets an outline too.
        .when(Boolean(mark), (el) => el.bg(MARK.hit)).when(mark === MARK.current, (el) => el.border_1().border_color(MARK.current)).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(r.id, cx))
        .child(svg(icon(TOOL_ICON[r.name] ?? "tool")).size(14).flex_none().text_color(t.dim))
        .child(div().flex_none().text_color(t.muted).child(verb))
        // The object, unless a card below says it again; mono only for paths, patterns and commands.
        .child(div().flex_1().min_w(0).truncate().when(CODE_OBJECT.has(r.name), (el) => el.font_family(mono).text_size(ts(13))).text_color(t.dim)
          .child(asking ? "" : /\n/.test(object ?? "") ? `${object.split("\n")[0].trimEnd()} …` : object))
        .when(Boolean(note), (el) => el.child(div().flex_none().text_size(ts(12.5)).text_color(note.declined ? t.blocked : t.dim).child(note.note)))
        .when(Boolean(state), (el) => el.child(div().flex_none().text_size(ts(12.5)).text_color(state[1]).child(state[0])))
        .when(!state && !note && r.state === "ok", (el) => el.child(svg(icon("check")).size(13).flex_none().text_color(t.dim)))
        .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim)))
      .when(open && !special, (el) => el.child(this.body(r, t, mono)))
      .when(special && r.name === "AskUserQuestion", (el) => el.child(div().ml(26).child(questionCard(this, r, t))))
      .when(special && r.name === "ExitPlanMode", (el) => el.child(div().ml(26).child(planCard(this, r, t))))
      .when(asking && !special, (el) => el.child(this.permissionCard(r, t, mono)));
  }

  // Three or more finished tools in a row fold into one line; a tool still running or asking stays out.
  // Claude's thinking, as the terminal shows it: one muted line, the whole of it on a click.
  thought(r, t) {
    const key = `th${r._i}`, open = this.open.has(key) || this.curRow() === r._i;
    return v_flex().id(key)
      .child(h_flex().id(`${key}h`).h(30).gap(8).items_center().px(4).rounded(4).cursor_pointer().text_size(ts(13.5))
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(key, cx))
        .child(svg(icon("sparkle")).size(14).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().italic().text_color(t.muted).child(open ? "Thinking" : r.text.replace(/\s+/g, " ")))
        .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none().text_color(t.dim)))
      .when(open, (el) => el.child(div().ml(26).mb(6).text_size(ts(13.5)).text_color(t.muted).child(TextView.markdown(`${key}m`, this.marked(r.text, r._i)).selectable())));
  }

  // Tool calls and the thinking between them. Three or more finished calls fold into one line; a call
  // still running or asking stays out, and so does the latest thought while Claude works (tail).
  tools(group, t, tail = false) {
    const live = (r) => r.state === "running" || r.ask?.state === "pending";
    const calls = (g) => g.filter((r) => r.kind === "tool");
    let k = group.findIndex(live);
    if (k === -1 && tail) k = Math.max(0, group.map((r) => r.kind).lastIndexOf("thinking"));
    if (k > 0 && calls(group.slice(0, k)).length >= 3) return v_flex().child(this.tools(group.slice(0, k), t)).child(this.tools(group.slice(k), t, tail));
    const list = () => v_flex().children(group.map((r) => (r.kind === "thinking" ? this.thought(r, t) : this.tool(r, t))));
    if (k !== -1 || calls(group).length < 3 || group.some((r) => this.findSet?.has(r._i))) return list();
    const key = `g-${calls(group)[0].id}`, open = this.open.has(key);
    const failed = group.filter((r) => r.state === "error" && !r.ask?.declined).length;
    const edits = group.filter((r) => r.diff).length;
    const fold = h_flex().id(key).h(30).gap(8).items_center().px(4).rounded(4).cursor_pointer().text_size(ts(13.5))
      .text_color(t.dim).hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.toggle(key, cx))
      .child(svg(icon("tool")).size(14).flex_none())
      .child(div().flex_1().child(`${calls(group).length} tool calls${edits ? ` · ${edits} edit${edits > 1 ? "s" : ""}` : ""}`))
      .when(failed > 0, (el) => el.child(div().text_size(ts(12.5)).text_color(t.blocked).child(`${failed} failed`)))
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none());
    return open ? v_flex().child(fold).child(list()) : fold;
  }

  // carded: the files card above already says what changed and links the review.
  // The turn's footer: its time (unless the Worked line says it), what it changed, checks, Review →; Copy and Quote on
  // hover. The checkpoint sha stays out: Review → is the way to it.
  end(r, i, t, said, carded = false, timed = false, hot = false) {
    const stat = carded ? "" : (r.stat || "")
      .replace(/(\d+) files? changed/, (_m, n) => `${n} file${n === "1" ? "" : "s"}`)
      .replace(/, (\d+) insertions?\(\+\)/, " +$1").replace(/, (\d+) deletions?\(-\)/, " −$1");
    const checks = { running: ["checks running", t.working], pass: ["checks pass", t.done], fail: ["checks failed", t.blocked] }[r.checks];
    const parts = [r.ms != null && !timed ? `${(r.ms / 1000).toFixed(1)}s` : null, stat].filter(Boolean);
    if (!parts.length && !checks && !said) return div().id(`e${i}`).h(10);
    const act = (id, label, glyph, onClick) => div().id(id).px(6).h(18).flex().gap(4).items_center().rounded(4).cursor_pointer()
      .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => onClick(cx))
      .when(Boolean(glyph), (el) => el.child(svg(icon(glyph)).size(12))).child(label);
    const copied = this.copied === `cr${i}`;
    return h_flex().id(`e${i}`).h(26).mt(6).gap(6).items_center().text_size(ts(12.5)).text_color(t.dim)
      .when(parts.length > 0, (el) => el.child(parts.join(" · ")))
      .when(Boolean(checks), (el) => el.child(div().text_color(checks[1]).child(parts.length ? `· ${checks[0]}` : checks[0])))
      .when(Boolean(r.checkpoint) && !carded, (el) => el.child(div().id(`rv${i}`).ml(4).px(6).h(18).flex().items_center().rounded(4).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.openReview()).child("Review →")))
      .when(Boolean(said) && (hot || this.hovers || copied), (el) => el.child(div().flex_1())
        .child(act(`cr${i}`, copied ? "Copied" : "Copy", copied ? "check" : "copy", (cx) => this.copy(`cr${i}`, said.text, cx)))
        .child(act(`qt${i}`, "Quote", null, (cx) => this.quote(said.text, cx))));
  }

  // What the terminal shows right now while Claude works: its spinner line ("Architecting… (1m 1s · ↓ 5k tokens)")
  // and the block it is on, from the feed's read of the screen. Falls back to the turn's latest step.
  liveBlock(t, last) {
    const live = this.view?.live, mono = codeFont();
    const [verb, object] = last?.kind === "tool" ? this.label(last) : [null, null];
    const now = live?.now || (last?.kind === "tool" ? `${verb} ${object ?? ""}` : last?.text?.replace(/\s+/g, " ") ?? "");
    return v_flex().id("live").ml(4).mt(2).mb(4).pl(12).gap(3).border_l(2).border_color(t.working)
      .child(h_flex().gap(8).items_center()
        .child(div().w(7).h(13).flex_none().bg(t.working).loop("opacity", { from: 0.15, to: 1, period: 1060 }))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(ts(12.5)).text_color(t.muted).child(live?.spin ?? "Working")))
      .when(Boolean(now), (el) => el.child(div().max_h(54).overflow_hidden().font_family(mono).text_size(ts(12.5)).text_color(t.dim).child(now)));
  }

  // The work inside a turn, as before the fold: narration, thinking and tool calls, three or more finished calls folded.
  work(rows, t, tail) {
    const out = [];
    for (let k = 0; k < rows.length; k++) {
      const r = rows[k];
      if (r.kind === "text") out.push(div().id(`n${r._i}`).py(3).text_size(ts(13.5)).text_color(t.muted).child(this.reply(r, r._i, t)));
      else if (r.kind === "tool" || r.kind === "thinking") {
        const group = [r];
        while (rows[k + 1]?.kind === "tool" || rows[k + 1]?.kind === "thinking") group.push(rows[++k]);
        out.push(div().id(`g${r._i}`).py(1).child(this.tools(group, t, tail && k === rows.length - 1)));
      }
    }
    return v_flex().children(out);
  }

  // A path outside the repo (Claude's memory, a temp file) under ~ instead of the whole of it.
  short(p) {
    const h = home().replace(/\\/g, "/"), q = p.replace(/\\/g, "/");
    return q.toLowerCase().startsWith(h.toLowerCase() + "/") ? "~" + q.slice(h.length) : p;
  }

  // The files a turn changed, with the review one click away (as T3 shows changed files under the answer).
  // A turn whose changes came from commands (no edit diffs) still gets the card, from its checkpoint's stat: the count and
  // the lines, without the list.
  filesCard(item, t) {
    const st = !item.files.length ? /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(item.end?.stat ?? "") : null;
    const count = st ? Number(st[1]) : item.files.length;
    const add = st ? Number(st[2] ?? 0) : item.files.reduce((n, f) => n + f.add, 0), del = st ? Number(st[3] ?? 0) : item.files.reduce((n, f) => n + f.del, 0);
    const mono = codeFont(), key = `fc${item.at}`, all = this.open.has(key), MAX = 5;
    const shown = all ? item.files : item.files.slice(0, MAX);
    const nums = (a, d) => h_flex().gap(6).flex_none().font_family(mono).text_size(ts(12.5))
      .when(a > 0, (el) => el.child(div().text_color(t.ansi2).child(`+${a}`))).when(d > 0, (el) => el.child(div().text_color(t.ansi1).child(`−${d}`)));
    return v_flex().id(key).mt(10).rounded(8).border_1().border_color(t.border).bg(t.chrome).overflow_hidden()
      .child(h_flex().h(34).px(12).gap(10).items_center().when(shown.length > 0, (el) => el.border_b(1).border_color(t.border))
        .child(div().text_size(ts(13.5)).text_color(t.foreground).child(`${count} changed file${count === 1 ? "" : "s"}`))
        .child(nums(add, del)).child(div().flex_1())
        .when(Boolean(item.end?.checkpoint), (el) => el.child(div().id(`fr${item.at}`).px(8).h(22).flex().items_center().rounded(4).cursor_pointer()
          .text_size(ts(13)).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.openReview()).child("Review →"))))
      .children(shown.map((f, k) => h_flex().id(`ff${item.at}-${k}`).h(26).px(12).gap(10).items_center()
        .child(svg(icon("file")).size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(ts(12.5)).text_color(t.muted).child(this.short(f.file)))
        .child(nums(f.add, f.del))))
      .when(item.files.length > MAX, (el) => el.child(div().id(`fm${item.at}`).h(26).px(12).flex().items_center().cursor_pointer()
        .text_size(ts(12.5)).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.toggle(key, cx))
        .child(all ? "Show fewer" : `${item.files.length - MAX} more`)));
  }

  // Pictures the turn's tools brought back (a Read of a PNG, a browser screenshot), outside the fold: the terminal
  // can't show them, the chat can. Each with the call that made it underneath.
  pictures(item, t) {
    const pics = item.work.filter((r) => r.kind === "tool" && r.images?.length);
    if (!pics.length) return null;
    const mono = codeFont();
    return h_flex().id(`pics${item.at}`).mt(6).mb(2).gap(10).flex_wrap().items_start()
      .children(pics.flatMap((r) => r.images.map((p, k) => v_flex().id(`pic${r._i}-${k}`).gap(4).max_w(360)
        .child(image(p).id(`pim${r._i}-${k}`).h(200).max_w(360).rounded(4).border_1().border_color(t.border))
        .child(div().max_w(360).truncate().font_family(mono).text_size(ts(12)).text_color(t.dim).child(`${this.label(r)[0]} ${this.short(r.summary ?? "")}`)))));
  }

  // One turn the way the terminal folds it: "Worked for 1m 32s · 6 tool calls ›", the answer, its files.
  // While Claude works: the same line, open on the live block; a permission or question card never hides in the fold.
  turnView(item, t, live) {
    const key = `wk${item.at}`, open = this.open.has(key) || item.work.some((r) => r._i === this.curRow());
    // Folded while it works too: what Claude last said about what it's doing, then the live block.
    const said = live && !open ? item.work.filter((r) => r.kind === "text").at(-1) : null;
    const started = this.rowsCache?.[item.at - 1]?.kind === "user" ? Date.parse(this.rowsCache[item.at - 1].at ?? "") : NaN;
    const ms = live ? (Number.isFinite(started) ? Date.now() - started : null) : item.end?.ms;
    const busy = item.work.length > 0 || live;
    const inFold = new Set(item.work.map((r) => r._i)), hidden = this.findList.filter((h) => inFold.has(h.i)).length;
    const header = h_flex().id(key).h(32).gap(6).items_center().rounded(4).cursor_pointer().text_size(ts(13.5)).text_color(t.dim)
      .hover((s) => s.text_color(t.muted)).on_click((_e, cx) => this.toggle(key, cx))
      // Folded over find hits: tinted, so a hit hidden inside still shows where it is.
      .child(div().child(summary(item, ms, live)))
      .when(!open && hidden > 0, (el) => el.child(div().px(6).rounded(4).bg(MARK.hit).text_color(t.foreground).child(`${hidden} match${hidden === 1 ? "" : "es"}`)))
      .when(item.stats.failed > 0, (el) => el.child(div().text_color(t.blocked).child(`· ${item.stats.failed} failed`)))
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).flex_none());
    const answer = item.answer, pics = this.pictures(item, t);
    const carded = item.files.length > 0 || /\d+ files? changed/.test(item.end?.stat ?? "");
    return v_flex().id(`turn${item.at}`).pt(6)
      .on_hover((h, cx) => { if (h) this.hover = key; else if (this.hover === key) this.hover = null; cx.notify(); })
      .when(busy, (el) => el.child(header))
      .when(open && item.work.length > 0, (el) => el.child(div().ml(2).pl(10).border_l(1).border_color(t.border).child(this.work(item.work, t, live))))
      .when(!open && item.asks.length > 0, (el) => el.child(v_flex().children(item.asks.map((r) => this.tool(r, t)))))
      .when(Boolean(said), (el) => el.child(div().pt(2).pb(4).text_color(t.muted).child(this.reply(said, said._i, t))))
      .when(Boolean(pics), (el) => el.child(pics))
      .when(live, (el) => el.child(this.liveBlock(t, item.work.at(-1))))
      .when(Boolean(answer), (el) => el.child(div().pt(10).opacity(answer._i >= this.newFrom ? this.fade() : 1).child(this.reply(answer, answer._i, t))))
      .when(!live && carded, (el) => el.child(this.filesCard(item, t)))
      .when(Boolean(item.end), (el) => el.child(this.end(item.end, item.end._i, t, answer, carded, busy && ms != null, this.hover === key)));
  }

  // [key, element, fresh] per item; the key is the item's first row, so it keeps its place as rows arrive,
  // and new items fade in. A user row doesn't: it was on screen already as the pending message.
  rows(rows, t) {
    this.rowsCache = rows;
    this.firstUser = rows.findIndex((r) => r.kind === "user");
    const working = this.status() === "working", items = turns(rows, working);
    const lastTurn = items.map((x) => x.kind).lastIndexOf("turn");
    // Which drawn item holds each row, so find can bring a hit into view.
    this.itemOfRow = new Map();
    items.forEach((x, n) => { for (const i of x.kind === "turn" ? [...x.work.map((r) => r._i), x.answer?._i, x.end?._i] : [x.i]) if (i != null) this.itemOfRow.set(i, n); });
    const out = items.map((x, n) => {
      if (x.kind === "user") return [`u${x.i}`, this.user(x.row, x.i, t), false];
      if (x.kind === "aside") return [`a${x.i}`, x.row.kind === "yap" ? yapRow(this, x.row, x.i, t) : x.row.kind === "crew" ? crewRow(x.row, x.i, t)
        : h_flex().id(`n${x.i}`).h(24).gap(8).items_center().text_size(ts(12.5)).text_color(t.dim)
          .child(div().h(1).w(16).bg(t.border)).child(x.row.text).child(div().h(1).flex_1().bg(t.border)), x.i >= this.newFrom];
      const live = working && n === lastTurn && !x.end && n === items.length - 1;
      return [`t${x.at}`, this.turnView(x, t, live), x.at >= this.newFrom];
    });
    this.liveShown = working && out.at(-1)?.[0]?.startsWith("t") && !items.at(-1)?.end;
    this.pending.forEach((p, k) => out.push([`p${k}`, this.user({ text: p.text }, `p${k}`, t, p), false]));
    return out;
  }

  modeMenuView(t) {
    const cur = this.view?.mode;
    return v_flex().id("mode-menu").mb(6).py(4).w(ts(410)).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .child(div().px(10).pt(4).pb(6).text_size(ts(12.5)).text_color(t.dim).child("Permissions"))
      .children(MODES.map((m) => h_flex().id(`mm-${m.id}`).px(10).py(6).gap(10).items_start().cursor_pointer()
        .when(m.id === cur, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.setMode(m.id, cx))
        .child(div().w(14).pt(1).flex_none().child(m.id === cur ? svg(icon("check")).size(13).text_color(t.foreground) : div()))
        .child(v_flex().flex_1().gap(1)
          .child(div().text_size(ts(13.5)).text_color(m.id === "bypass" ? t.blocked : t.foreground).child(m.label))
          .child(div().text_size(ts(12.5)).text_color(t.dim).child(m.desc)))))
      .child(div().px(10).pt(6).pb(4).text_size(ts(12)).text_color(t.dim).child("Same as Shift+Tab in the terminal"))
      .child(div().mt(4).h(1).bg(t.border))
      .child(div().px(10).pt(8).pb(6).text_size(ts(12.5)).text_color(t.dim).child("Chat"))
      .child(h_flex().id("opt-fork").px(10).py(6).gap(10).items_start().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleFork(cx))
        .child(div().w(14).pt(1).flex_none().child(this.forkOn() ? svg(icon("check")).size(13).text_color(t.foreground) : div()))
        .child(v_flex().flex_1().gap(1)
          .child(div().text_size(ts(13.5)).text_color(t.foreground).child("Fork from a message"))
          .child(div().text_size(ts(12.5)).text_color(t.dim).child("Branch at any of your messages, in a new tab"))))
      .child(h_flex().id("opt-notify").px(10).py(6).gap(10).items_start().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => this.toggleNotify(cx))
        .child(div().w(14).pt(1).flex_none().child(this.notifyOn() ? svg(icon("check")).size(13).text_color(t.foreground) : div()))
        .child(v_flex().flex_1().gap(1)
          .child(div().text_size(ts(13.5)).text_color(t.foreground).child("Desktop notifications"))
          .child(div().text_size(ts(12.5)).text_color(t.dim).child("When a Claude needs you and Herdr isn't in front"))))
      .child(this.spaceNotifyRow(t))
      .child(this.choiceRow("opt-size", "Text size", "kodr.chat.size", "m", SIZES, t))
      .child(this.choiceRow("opt-font", "Font", "kodr.chat.font", "zed", FONTS, t));
  }

  // A chat look option as segments (shared, so every chat follows).
  choiceRow(id, label, key, fallback, choices, t) {
    const cur = shared(key) ?? fallback;
    const seg = ([k, name]) => div().id(`${id}-${k}`).px(8).h(22).flex().items_center().text_size(ts(12.5))
      .when(k === cur, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(k !== cur, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { setShared(key, k); cx.notify(); }))
      .child(name);
    return h_flex().id(id).px(10).py(6).gap(10).items_center()
      .child(div().w(14).flex_none())
      .child(div().flex_1().text_size(ts(13.5)).text_color(t.foreground).child(label))
      .child(h_flex().flex_none().rounded(4).border_1().border_color(t.border).overflow_hidden().children(choices.map(seg)));
  }

  // Notifications for this chat's space: All (needs you and done), Needs me (permissions, questions), Off.
  // kodr-pane reads kodr.notify.spaces ({ space id: level }, "all" when unset) before it notifies.
  spaceNotifyRow(t) {
    const a = agents().find((x) => x.address === this.target);
    const space = a?.space ?? focused()?.space;
    if (!space) return div();
    const levels = shared("kodr.notify.spaces") ?? {}, cur = NOTIFY_LEVELS.some(([k]) => k === levels[space]) ? levels[space] : "all";
    const seg = ([k, label]) => div().id(`nl-${k}`).px(8).h(22).flex().items_center().text_size(ts(12.5))
      .when(k === cur, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(k !== cur, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => { setShared("kodr.notify.spaces", { ...(shared("kodr.notify.spaces") ?? {}), [space]: k }); cx.notify(); }))
      .child(label);
    return h_flex().id("opt-space-notify").px(10).py(6).gap(10).items_center()
      .child(div().w(14).flex_none())
      .child(v_flex().flex_1().gap(1)
        .child(div().text_size(ts(13.5)).text_color(t.foreground).child(`Notifications in ${a?.space_name ?? "this space"}`))
        .child(div().text_size(ts(12.5)).text_color(t.dim).child({ all: "Needs you, and done", needs: "Only when a Claude needs you", off: "None from this space" }[cur])))
      .child(h_flex().flex_none().rounded(4).border_1().border_color(t.border).overflow_hidden().children(NOTIFY_LEVELS.map(seg)));
  }

  menuView(t) {
    const { kind, items, index } = this.menu;
    if (this.menuSeek) { this.menuScroll.scroll_to_item(index); this.menuSeek = false; }
    // Tags only tell sources apart when the list mixes them (a skill among commands); built-ins go untagged.
    const mixed = new Set(items.map((it) => it.tag)).size > 1;
    return v_flex().id("menu").mb(6).max_h(32 * 9 + 8).py(4).rounded(8).border_1().border_color(t.border).bg(t.popover)
      .overflow_y_scroll().track_scroll(this.menuScroll)
      .when(!items.length, (el) => el.child(div().h(32).px(12).flex().items_center().text_size(ts(13.5)).text_color(t.dim)
        .child(kind === "@" ? "No files match" : kind === "$" ? "No skills match" : "No commands match")))
      .children(items.map((it, i) => h_flex().id(`mi${i}`).h(32).flex_none().px(12).gap(10).items_center().cursor_pointer()
        .when(i === index, (el) => el.bg(t.selected)).when(i !== index, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.menu.index = i; this.accept(cx); })
        .when(kind === "@", (el) => el.child(svg(icon("file")).size(13).flex_none().text_color(t.dim)))
        .child(div().flex_none().max_w(320).truncate().text_size(ts(13.5)).text_color(t.foreground).child(kind === "@" ? it.label : `${kind}${it.label}`))
        .child(div().flex_1().min_w(0).truncate().text_size(ts(13)).text_color(t.dim).child(it.desc))
        .when(mixed && Boolean(it.tag) && it.tag !== "built-in", (el) => el.child(div().flex_none().text_size(ts(12)).text_color(t.dim).child(it.tag)))));
  }

  // What Enter does while Claude works: Queue or Steer (remembered; Ctrl+Enter does the other).
  enterSwitch(t) {
    const steer = this.steersByDefault();
    const seg = (id, label, on, value) => div().id(id).px(8).h(20).flex().items_center().text_size(ts(12.5))
      .when(on, (el) => el.bg(t.selected).text_color(t.foreground))
      .when(!on, (el) => el.text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { setShared("kodr.chat.enter", value); cx.notify(); }))
      .child(label);
    return h_flex().id("enter-mode").mr(4).gap(6).items_center()
      .child(div().text_size(ts(12)).text_color(t.dim).child("Enter"))
      .child(h_flex().rounded(4).border_1().border_color(t.border).overflow_hidden()
        .child(seg("em-q", "Queue", !steer, "queue"))
        .child(seg("em-s", "Steer", steer, "steer")))
      .child(div().text_size(ts(12)).text_color(t.dim).child(`Ctrl+Enter ${steer ? "queues" : "steers"}`));
  }

  composer(t, status) {
    const busy = status === "working" || status === "blocked";
    const mode = this.modeBusy ?? this.view?.mode, m = modeOf(mode);
    return v_flex().w_full().max_w(MAX_W)
      .when(Boolean(this.menu) && !this.modeMenu, (el) => el.child(this.menuView(t)))
      .when(this.modeMenu, (el) => el.child(this.modeMenuView(t)))
      .when(Boolean(this.yap) && !this.menu && !this.modeMenu, (el) => el.child(yapStrip(this, t)))
      .when(Boolean(this.view?.todos?.length) && !this.menu && !this.modeMenu, (el) => el.child(todosPanel(this, this.view.todos, t)))
      .when(Boolean(this.modeNote), (el) => el.child(h_flex().mb(6).px(10).py(6).gap(8).items_center().rounded(8).border_1().border_color(t.border).bg(t.chrome)
        .text_size(ts(13)).text_color(t.muted).child(div().flex_1().child(this.modeNote))
        .child(div().id("note-x").cursor_pointer().on_click((_e, cx) => { this.modeNote = null; cx.notify(); }).child(svg(icon("x")).size(11)))))
      .child(v_flex().id("composer").rounded(8).border_1().border_color(this.typing ? t.accent : t.border).bg(t.surface).shadow_md()
        // Pasted images, before sending: a thumbnail each (a chip while the copy is still being made).
        .when(this.images.length > 0, (el) => el.child(h_flex().px(10).pt(10).gap(8).items_end()
          .children(this.images.map((im, k) => im.path
            ? image(im.path).id(`pi${k}`).h(64).max_w(160).rounded(4).border_1().border_color(t.border)
            : h_flex().id(`pi${k}`).h(64).w(88).items_center().justify_center().rounded(4).border_1().border_color(t.border).text_color(t.dim)
                .child(svg(icon("image")).size(16))))
          .child(div().pb(2).text_size(ts(12.5)).text_color(t.dim).child(`In Claude's input · sent with your message`))))
        .child(div().id("editor").px(16).pt(14).pb(8).on_key_down((e, cx) => this.onKey(e, cx))
          .when(Boolean(this.menu) && !this.modeMenu, (el) => el.key_context("KodrMenu"))
          .on_action("kodr_menu_up", (_e, cx) => this.menuMove(-1, cx))
          .on_action("kodr_menu_down", (_e, cx) => this.menuMove(1, cx))
          .on_action("kodr_menu_pick", (_e, cx) => { if (this.menu) this.accept(cx); })
          .on_action("kodr_menu_close", (_e, cx) => { this.menu = null; cx.notify(); }).on_modifiers_changed((e) => { this.mods = e.modifiers; })
          .child(Textarea.new(this.input).w_full().text_size(ts(15)).text_color(t.foreground)))
        .child(h_flex().h(42).px(8).pb(2).gap(2).items_center()
          .child(this.iconButton("at", "at", t, (cx) => this.insert("@", cx)))
          .child(this.iconButton("slash", "slash", t, (cx) => this.insert("/", cx)))
          .child(this.iconButton("skill", "sparkle", t, (cx) => this.insert("$", cx)))
          .when(Boolean(mode), (el) => el.child(div().id("mode").ml(4).px(8).h(24).flex().gap(6).items_center().rounded(4).cursor_pointer()
            .text_size(ts(13)).text_color(mode === "bypass" ? t.blocked : mode === "manual" ? t.muted : t.foreground)
            .when(this.modeMenu, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.modeMenu = !this.modeMenu; this.menu = null; cx.notify(); })
            .child(svg(icon("shield")).size(13))
            .child(this.modeBusy ? `${m?.label ?? mode}…` : m?.label ?? mode)
            .child(svg(icon("chevron-down")).size(11).text_color(t.dim))))
          .child(div().flex_1())
          .when(status === "working", (el) => el.child(this.enterSwitch(t)))
          .child(div().id("model").px(8).h(26).flex().items_center().rounded(4).cursor_pointer().font_family(codeFont()).text_size(ts(12.5)).text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.insert("/model ", cx))
            .child(modelName(this.view?.model)))
          .when(busy, (el) => el.child(this.iconButton("stop", "stop", t, (cx) => this.interrupt(cx), true)))
          .child(busy && !this.input.value().trim() ? div()
            : this.input.value().trim() || this.images.length
              ? div().id("send").size(28).flex().items_center().justify_center().rounded(4).cursor_pointer()
                .bg(t.accent).text_color(t.accent_foreground).hover((s) => s.opacity(0.9)).on_click((_e, cx) => this.send(cx))
                .child(svg(icon("send")).size(14))
              // Nothing to send yet: the button rests, greyed.
              : div().id("send").size(28).flex().items_center().justify_center().rounded(4).bg(t.hover).text_color(t.dim)
                .child(svg(icon("send")).size(14)))));
  }

  render(cx) {
    // Deft's ramp on herdr's theme: hairlines a step lighter than the surface (the theme's border is darker than the
    // page, which reads as a groove), raised surfaces for what holds your words (your message, the composer).
    const base = theme(), v = this.view;
    // One colour per meaning: needs-you is blocked (red) everywhere, done is green (blue stays the accent: send, a pick),
    // and dim text is lifted to read (4.5:1).
    const t = { ...base, border: base.selected, surface: base.raised, dim: readable(base.dim, base.foreground, base.background), done: base.ansi2 ?? base.done };
    const status = v ? this.status() : "idle";
    if (!v) {
      return v_flex().id("kodr-chat").size_full().items_center().justify_center().bg(t.background).text_color(t.dim).text_size(ts(13.5))
        .child(this.error ? `Couldn't read this session: ${this.error}` : this.target ? "Loading the conversation…" : "Open a Claude terminal started with Kodr to see its chat.");
    }
    this.hinted = false;
    this.findSync(v.rows);
    this.findSet = new Set(this.findList.map((h) => h.i));
    const items = this.rows(v.rows, t);
    // Empty: one line in the middle of the pane (the box below already lists / $ @).
    const empty = !items.length;
    if (empty) items.push(["empty", v_flex().id("empty").gap(6).items_center().text_color(t.dim).text_size(ts(13.5))
      .child(div().text_size(ts(16)).text_color(t.muted).child("Ask Claude anything"))
      .child("Paste an image or drop a file to show it")]);
    // Deft's block caret, pulsing natively.
    // Just sent, no turn yet: the live block on its own.
    if (status === "working" && !this.liveShown) items.push(["working", div().id("working").pt(6).child(this.liveBlock(t, null))]);
    items.push(["bottom", div().id("bottom").h(16)]);
    if (this.seekRow != null && this.itemOfRow.has(this.seekRow)) { this.scroll.scroll_to_item(this.itemOfRow.get(this.seekRow)); this.seekRow = null; this.stick = false; }
    if (this.stick) { this.scroll.scroll_to_item(items.length - 1); this.stick = false; }
    return v_flex().id("kodr-chat").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(ts(14.5)).line_height(`${Math.round(24 * zoom())}px`).when(Boolean(chatFont()), (el) => el.font_family(chatFont()))
      .on_drop((e, cx) => this.drop(e.paths, cx))
      // Ctrl+F from anywhere in the chat (the message box, the find box) opens find, or goes back to it.
      .track_focus(this.rootKeys)
      .on_key_down((e, cx) => {
        if (!["ctrl-f", "cmd-f"].includes(e.keystroke)) return;
        cx.stop_propagation();
        this.openFind(cx);
      })
      .when(this.findOpen, (el) => el.child(this.findBar(t)))
      .child(v_flex().id("thread").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).px(28).items_center().when(empty, (el) => el.justify_center())
        .on_scroll_wheel((e, cx) => this.wheel(e, cx))
        .children(items.map(([key, el, fresh]) => div().id(`row-${key}`).w_full().max_w(MAX_W)
          .opacity(fresh ? this.fade() : 1).child(el))))
      .when(this.unseen && !this.follow, (el) => el.child(h_flex().flex_none().justify_center().pt(6)
        .child(div().id("jump").px(10).h(24).flex().gap(6).items_center().rounded(4).border_1().border_color(t.border).bg(t.chrome).shadow_sm()
          .text_size(ts(13)).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => this.jump(cx))
          .child(svg(icon("chevron-down")).size(12)).child("Jump to latest"))))
      .when(Boolean(this.error), (el) => el.child(div().px(20).py(4).text_size(ts(12.5)).text_color(t.blocked).child(this.error)))
      .child(v_flex().flex_none().px(28).pt(10).pb(16).items_center().child(this.composer(t, status)));
  }
}
