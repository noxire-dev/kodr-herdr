#!/usr/bin/env node
// Prints one herdr terminal's Claude session as chat rows (JSON), for the kodr-chat mod's exec.
// Stateless: reads the transcript's tail, the turns the Stop hook recorded, and the asks.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { terminalDir, readJson, writeJson, tailLines, transcriptOf, claudeProcess } from "../lib/store.mjs";
import { goalOf, attach } from "./kodr-crew.mjs";
import { draftOf } from "../mod/kodr-chat/draft.js";

const TAIL = 32 * 1024 * 1024, MAX_ROWS = 400, MAX_TEXT = 20_000, MAX_OUT = 2_000, MAX_DIFF = 80;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "\n…" : s);
const NOTE_TTL = 6 * 3600_000;

// Claude hands the hook a tool's input with its keys in another order: compare them sorted.
const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
const keyOf = (json) => { try { return canon(JSON.parse(json)); } catch { return json; } };

// The lines an edit changes, as -/+ (common leading and trailing lines dropped), capped.
// "Messages for you through yap:" context, as rows: { kind: "yap", dir: "in", from, sender, type, id, re, text }.
// Lines as YAP writes them: "From session @x[, answering abc]: …", "Question abc from session @x: … (answer with …)",
// "Blocker …", "New note on the board, #6 from session @x: …"; anything else is kept whole.
export function yapMessages(context) {
  const at = context.indexOf("Messages for you through yap:");
  if (at < 0) return [];
  const body = context.slice(at).split("\n").slice(1);
  const items = [];
  for (const line of body) {
    if (/^These are information|^The user has turned on trusted handoffs/.test(line)) break;
    if (line.startsWith("- ")) items.push(line.slice(2));
    else if (items.length) items[items.length - 1] += "\n" + line;
  }
  // Senders often open with their own name ("From @yap: …"); the row already says who.
  const bare = (m) => ({ ...m, text: m.text.replace(new RegExp(`^(From )?${m.from.replace(/[.*+?^${}()|[]\]/g, "\  return items.map((s) => {")}: `), "") });
  return items.map((s) => bare(parse(s)));
}
function parse(s) {
  {
    let m;
    if ((m = /^(Question|Blocker) (\w+) from (.+?): ([\s\S]*?)(?: \(answer with `yap say --re \w+ <text>`\))?$/.exec(s)))
      return { kind: "yap", dir: "in", type: m[1].toLowerCase(), id: m[2], ...who(m[3]), text: m[4] };
    if ((m = /^From (.+?)(?:, answering (\w+))?: ([\s\S]*)$/.exec(s))) return { kind: "yap", dir: "in", type: "say", re: m[2] ?? null, ...who(m[1]), text: m[3] };
    if ((m = /^New note on the board, #(\d+) from (.+?): ([\s\S]*)$/.exec(s))) return { kind: "yap", dir: "in", type: "note", note: m[1], ...who(m[2]), text: m[3] };
    // yap's crew reporting on a goal this session handed it.
    if ((m = /^The crew merged goal (\d+), which you handed it: ([\s\S]*)$/.exec(s))) return { kind: "yap", dir: "in", type: "goal", goal: Number(m[1]), from: "the crew", sender: null, text: m[2] };
    if ((m = /^Goal (\d+), which you handed the crew, is stuck and needs a human: ([\s\S]*)$/.exec(s))) return { kind: "yap", dir: "in", type: "stuck", goal: Number(m[1]), from: "the crew", sender: null, text: m[2] };
    return { kind: "yap", dir: "in", type: "say", from: "yap", sender: null, text: s };
  }
}
const who = (label) => {
  const s = /^session @(\S+)$/.exec(label);
  return s ? { from: `@${s[1]}`, sender: s[1] } : { from: label, sender: null };
};

// Claude's own `yap say …` (a Bash call, or the yap MCP tool) as an outgoing message row.
export function yapSay(b) {
  if (b.name === "mcp__yap__say" || b.name === "mcp__plugin_yap_yap__say")
    return { kind: "yap", dir: "out", id: b.id, to: b.input?.to ? `@${String(b.input.to).replace(/^@/, "")}` : "everyone", type: b.input?.kind ?? "say", re: b.input?.re ?? null, text: String(b.input?.text ?? "") };
  if (b.name !== "Bash" && b.name !== "PowerShell") return null;
  // Shell words: quoted strings, the operators that end a command (&& || ; | newline), and plain words. A `yap say`
  // may follow another command; its message ends at the next operator or redirect.
  const tokens = String(b.input?.command ?? "").match(/'[^']*'|"(?:\\.|[^"])*"|&&|\|\||[;|\n]|[^\s;|&'"]+/g) ?? [];
  const op = (w) => /^(&&|\|\||[;|\n])$/.test(w);
  const at = tokens.findIndex((w, i) => w === "yap" && tokens[i + 1] === "say" && (i === 0 || op(tokens[i - 1])));
  if (at < 0) return null;
  const end = tokens.findIndex((w, i) => i > at + 1 && (op(w) || /^\d?>/.test(w)));
  const words = tokens.slice(at + 2, end < 0 ? undefined : end);
  const unquote = (w) => w.replace(/^'([\s\S]*)'$|^"([\s\S]*)"$/, (_m, a, b2) => a ?? b2.replace(/\\(.)/g, "$1"));
  let type = "say", re = null, to = "everyone";
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const w = unquote(words[i]);
    if (w === "--question" || w === "--blocker") type = w.slice(2);
    else if (w === "--re") re = unquote(words[++i] ?? "") || null;
    else if (!rest.length && w.startsWith("@")) to = w;
    else rest.push(w);
  }
  return { kind: "yap", dir: "out", id: b.id, to, type, re, text: rest.join(" ") };
}

export function diffOf(name, input = {}) {
  const lines = (s) => String(s ?? "").split("\n");
  const pair = (a, b) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    let j = 0;
    while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
    return [...a.slice(i, a.length - j).map((x) => "-" + x), ...b.slice(i, b.length - j).map((x) => "+" + x)];
  };
  let out = null;
  if (name === "Edit") out = pair(lines(input.old_string), lines(input.new_string));
  else if (name === "MultiEdit") out = (input.edits ?? []).flatMap((e, k) => [...(k ? ["@@"] : []), ...pair(lines(e.old_string), lines(e.new_string))]);
  else if (name === "Write") out = lines(input.content).map((x) => "+" + x);
  if (!out) return null;
  return out.length > MAX_DIFF ? [...out.slice(0, MAX_DIFF), `… ${out.length - MAX_DIFF} more lines`] : out;
}

// What a tool row keeps of its input for the cards that need more than a summary.
function detail(name, input = {}) {
  if (name === "AskUserQuestion") return { questions: input.questions ?? [] };
  if (name === "ExitPlanMode") return { plan: clip(String(input.plan ?? ""), MAX_TEXT) };
  if (name === "TodoWrite") return { todos: input.todos ?? [] };
  if (name === "Task" || name === "Agent") return { agent: input.subagent_type ?? null, prompt: clip(String(input.prompt ?? ""), 1200) };
  return null;
}

// Every long "data":"<base64>" emptied (a scan: a regex over megabytes overflows the stack). An image
// among them is handed to keep() first and replaced by what it returns ("kodr-img:<path>", see imageFile).
const MAGIC = [["iVBORw0KGgo", "image/png"], ["/9j/", "image/jpeg"], ["R0lGOD", "image/gif"], ["UklGR", "image/webp"]];
export function blankData(s, keep = () => "") {
  let out = "", at = 0;
  for (let i = s.indexOf('"data":"'); i !== -1; i = s.indexOf('"data":"', at)) {
    const from = i + 8, to = s.indexOf('"', from);
    if (to === -1) break;
    const media = to - from > 1024 && MAGIC.find(([m]) => s.startsWith(m, from))?.[1];
    out += s.slice(at, from) + (to - from <= 1024 ? s.slice(from, to) : media ? keep(s.slice(from, to), media) : "");
    at = to;
  }
  return out + s.slice(at);
}

export function feed(t) {
  const dir = terminalDir(t);
  const s = readJson(path.join(dir, "session.json"), null);
  if (!s) return null;
  // An attached session (feed/kodr-attach.mjs) follows its Claude process across /clear.
  if (s.pid) {
    const now = claudeProcess(s.pid)?.sessionId;
    const transcript = now && now !== s.session && transcriptOf(now);
    if (transcript) { Object.assign(s, { session: now, transcript }); writeJson(path.join(dir, "session.json"), s); }
  }
  // Paths in the project read relative to it, however Claude wrote the slashes (and inside a `cd "<cwd>" &&`).
  const cwdKey = (s.cwd ?? "").replace(/\\/g, "/").toLowerCase();
  const rel = (v) => {
    if (typeof v !== "string" || !cwdKey) return v;
    const f = v.replace(/\\/g, "/"), i = f.toLowerCase().indexOf(cwdKey + "/");
    if (i === 0) return f.slice(cwdKey.length + 1);
    const cd = f.toLowerCase().indexOf(`cd "${cwdKey}" && `);
    return cd === 0 ? f.slice(cwdKey.length + 9) : v;
  };
  const summarize = (input = {}) => {
    if (input.taskId) return `#${input.taskId}${input.status ? ` → ${input.status.replace("_", " ")}` : ""}`;
    const v = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.subject ?? input.description ?? input.query ?? input.skill;
    return clip(String(rel(typeof v === "string" ? v : JSON.stringify(input))), 200);
  };
  const turns = readJson(path.join(dir, "turns.json"), { turns: [] }).turns;
  const anchors = new Map(turns.map((x) => [x.anchor, x]));
  let reviewed = null;
  try { reviewed = fs.readFileSync(path.join(dir, "reviewed"), "utf8").trim() || null; } catch {}

  // A pasted image is base64 in the transcript. Mods draw images only from herdr's app folder,
  // so each is kept there once, named by the path the mod's image() takes.
  const imageFile = (src) => {
    if (src?.type !== "base64" || !src.data) return null;
    if (src.data.startsWith("kodr-img:")) return src.data.slice(9); // kept already, by blankData
    const ext = (src.media_type ?? "image/png").split("/")[1]?.replace("jpeg", "jpg") ?? "png";
    const appHome = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app");
    const relPath = `data/kodr-chat/img/${crypto.createHash("sha1").update(src.data).digest("hex").slice(0, 16)}.${ext}`;
    const file = path.join(appHome, relPath);
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(src.data, "base64"));
    }
    return relPath;
  };

  const rows = [], tools = new Map();
  let model = null, pendingTurn = null, todos = null;
  // Claude Code's task list (TaskCreate / TaskUpdate; TodoWrite on older versions), for the plan panel.
  const tasks = new Map(), creating = new Map();
  const end = (ms) => {
    rows.push({ kind: "end", ms, ...(pendingTurn ? { checkpoint: pendingTurn.sha, stat: pendingTurn.stat, checks: pendingTurn.checks, results: pendingTurn.results } : {}) });
    pendingTurn = null;
  };
  for (const raw of tailLines(s.transcript, TAIL)) {
    // Screenshots a tool read come back as megabytes of base64: each image is kept as a file and its base64
    // dropped before parsing (images the person pasted are in user lines and keep theirs).
    const line = raw.length > 256 * 1024 && raw.includes('"tool_result"')
      ? blankData(raw, (data, media_type) => "kodr-img:" + imageFile({ type: "base64", media_type, data })) : raw;
    let l;
    try { l = JSON.parse(line); } catch { continue; }
    if (l.isSidechain) continue;
    // YAP hands messages to the session as hook context: each one becomes a row.
    if (l.type === "attachment" && l.attachment?.type === "hook_additional_context") {
      for (const c of [].concat(l.attachment.content ?? [])) for (const m of yapMessages(String(c))) rows.push(m);
      continue;
    }
    // After auto-compaction Claude Code writes its summary as a user line; the terminal shows only a divider.
    if (l.type === "user" && l.isCompactSummary) { rows.push({ kind: "note", text: "Context compacted: earlier turns were summarized for Claude" }); continue; }
    if (l.type === "user" && !l.isMeta) {
      const c = l.message?.content;
      if (typeof c === "string") {
        const cmd = /<command-name>([^<]*)<\/command-name>/.exec(c);
        const woke = /^yap: a message from (.+)$/.exec(c.trim());
        if (woke) rows.push({ kind: "note", text: `Woken by ${woke[1].replace(/^session /, "")}` });
        else if (cmd) rows.push({ kind: "user", text: cmd[1], at: l.timestamp });
        else if (c.trim().startsWith("[Request interrupted")) rows.push({ kind: "note", text: "Interrupted" });
        else if (!c.startsWith("<")) rows.push({ kind: "user", text: clip(c, MAX_TEXT), at: l.timestamp, uuid: l.uuid });
      } else if (Array.isArray(c)) {
        const images = [];
        let text = null;
        for (const b of c) {
          if (b.type === "tool_result") {
            const row = tools.get(b.tool_use_id);
            if (!row) continue;
            const out = typeof b.content === "string" ? b.content : (b.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
            // A call stopped or turned down (Stop, Ctrl+Enter, Deny) didn't fail.
            row.state = !b.is_error ? "ok" : out.startsWith("The user doesn't want to proceed with this tool use") ? "stopped" : "error";
            row.output = out.length > MAX_OUT ? "…" + out.slice(-MAX_OUT) : out;
            // A goal handed to yap's crew: a card of its own (filled with the crew's live state by attach()).
            const goal = /^(Bash|PowerShell)$/.test(row.name) ? goalOf(row.summary, out) : null;
            if (goal) rows.push({ kind: "crew", goal, at: l.timestamp });
            // A Read of a picture, a browser screenshot: the chat shows the image itself.
            const pics = (Array.isArray(b.content) ? b.content : []).filter((x) => x.type === "image").map((x) => imageFile(x.source)).filter(Boolean);
            if (pics.length) row.images = pics;
            const made = creating.get(b.tool_use_id), n = /Task #(\w+) created/.exec(out)?.[1];
            if (made && n) tasks.set(n, { ...made, status: "pending" });
          } else if (b.type === "image") {
            const f = imageFile(b.source);
            if (f) images.push(f);
          } else if (b.type === "text" && !b.text.startsWith("<")) text = (text ? text + "\n" : "") + b.text;
        }
        // Claude's own marker when a turn is stopped: a note, not something the person said.
        if (text !== null && text.trim().startsWith("[Request interrupted")) { rows.push({ kind: "note", text: "Interrupted" }); continue; }
        if (text !== null || images.length) rows.push({ kind: "user", text: clip((text ?? "").replace(/\[Image #\d+\]\s*/g, "").trim(), MAX_TEXT), images, at: l.timestamp, uuid: l.uuid });
      }
    } else if (l.type === "assistant") {
      model = l.message?.model ?? model;
      for (const b of l.message?.content ?? []) {
        if (b.type === "text" && b.text.trim()) rows.push({ kind: "text", text: clip(b.text, MAX_TEXT) });
        // The terminal shows Claude's thinking, and its progress notes often arrive there rather than as text.
        else if (b.type === "thinking" && b.thinking?.trim()) rows.push({ kind: "thinking", text: clip(b.thinking.trim(), MAX_TEXT) });
        else if (b.type === "tool_use" && yapSay(b)) rows.push(yapSay(b));
        else if (b.type === "tool_use") {
          const row = { kind: "tool", id: b.id, name: b.name, summary: summarize(b.input), state: "running", key: canon(b.input ?? {}) };
          const diff = diffOf(b.name, b.input);
          if (diff) row.diff = diff;
          const more = detail(b.name, b.input);
          if (more) row.detail = more;
          if (b.name === "TodoWrite") todos = b.input?.todos ?? null;
          if (b.name === "TaskCreate") creating.set(b.id, { content: b.input?.subject ?? "", activeForm: b.input?.activeForm });
          if (b.name === "TaskUpdate" && tasks.has(String(b.input?.taskId))) {
            const task = tasks.get(String(b.input.taskId));
            if (b.input.status) task.status = b.input.status;
            if (b.input.subject) task.content = b.input.subject;
          }
          tools.set(b.id, row);
          rows.push(row);
        }
      }
    } else if (l.type === "system" && l.subtype === "turn_duration") end(l.durationMs);
    if (l.uuid && anchors.has(l.uuid)) pendingTurn = anchors.get(l.uuid);
  }
  if (pendingTurn) end(null);

  // An ask belongs to the tool call with the same name and input: open ones get a card, finished
  // ones (answered here, in the terminal, or gone) a quiet note.
  const asksDir = path.join(dir, "asks");
  let names = [];
  try { names = fs.readdirSync(asksDir); } catch {}
  const place = (tool, key) =>
    [...rows].reverse().find((r) => r.kind === "tool" && r.name === tool && !r.ask && r.key === key) ??
    [...rows].reverse().find((r) => r.kind === "tool" && r.name === tool && !r.ask && r.state === "running");
  for (const n of names.filter((x) => x.endsWith(".end")).sort()) {
    const e = readJson(path.join(asksDir, n), null);
    if (!e?.note || Date.now() - (e.at ?? 0) > NOTE_TTL) continue;
    const row = place(e.tool, keyOf(e.key));
    if (row) row.ask = { id: n.slice(0, -4), state: "done", note: e.note, declined: Boolean(e.declined) };
  }
  for (const n of names.filter((x) => x.endsWith(".req.json")).sort()) {
    const req = readJson(path.join(asksDir, n), null);
    if (!req || names.includes(n.replace(".req.json", ".ans.json"))) continue;
    const ask = { id: req.id, state: "pending" };
    const key = canon(req.input ?? {});
    const row = place(req.tool, key);
    if (row) row.ask = ask;
    else {
      const r = { kind: "tool", id: `ask-${req.id}`, name: req.tool, summary: summarize(req.input), state: "running", key, ask };
      const diff = diffOf(req.tool, req.input);
      if (diff) r.diff = diff;
      const more = detail(req.tool, req.input);
      if (more) r.detail = more;
      rows.push(r);
    }
  }
  for (const r of rows) delete r.key;

  if (tasks.size) todos = [...tasks.values()].filter((x) => x.status !== "deleted");
  const latest = turns.at(-1) ?? null;
  const { mode, live, draft } = screen(t);
  // The crew's report on a goal whose card is in this chat is already on that card: one copy.
  const carded = new Set(rows.filter((r) => r.kind === "crew").map((r) => r.goal));
  const shown = rows.filter((r) => !((r.type === "goal" || r.type === "stuck") && carded.has(r.goal)));
  return { terminal: t, cwd: s.cwd, base: s.base, session: s.session, transcript: s.transcript, model, mode, live, draft, reviewed, latest, todos, rows: shown.slice(-MAX_ROWS) };
}

// The permission mode Claude's status line shows right now (Shift+Tab cycles it); null while a
// dialog covers the status line.
const MODES = [[/bypass permissions on/i, "bypass"], [/accept edits on/i, "acceptEdits"], [/plan mode on/i, "plan"], [/auto mode on/i, "auto"], [/manual mode on/i, "manual"]];
// Claude's screen: the mode from its status line, and while it works, the spinner line ("✻ Architecting… (1m 1s · …)")
// with the block it is on (its "●" line and what follows, up to the spinner), so the chat says what the terminal says.
export function readScreen(text) {
  const lines = text.replace(/\r/g, "").split("\n");
  const tail = lines.slice(-4).join("\n");
  const mode = MODES.find(([re]) => re.test(tail))?.[1] ?? null;
  const rules = lines.map((l, i) => (/^─{10,}/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const above = lines.slice(0, rules.length >= 2 ? rules.at(-2) : lines.length);
  const spinAt = above.findLastIndex((l) => /^\S\s+\S.*…/.test(l) && !/^[●⎿❯]/.test(l));
  if (spinAt === -1) return { mode, live: null };
  const blockAt = above.slice(0, spinAt).findLastIndex((l) => l.startsWith("●"));
  const now = blockAt === -1 ? "" : above.slice(blockAt, spinAt).join(" ").replace(/^●\s*/, "").replace(/\s+/g, " ").trim();
  return { mode, live: { spin: above[spinAt].replace(/^\S\s+/, "").trim(), now: now.slice(0, 300) } };
}

function screen(t) {
  const hc = readJson(path.join(os.homedir(), ".kodr-herdr", "config.json"), {}).hc ?? process.env.KODR_HC ?? "hc";
  try {
    const text = execFileSync(hc, ["read", t], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { ...readScreen(text), draft: Boolean(draftOf(text).text) }; // unsent text in the terminal: the chat takes it
  } catch { return { mode: null, live: null, draft: false }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--self-check") {
    const assert = (await import("node:assert")).default;
    assert.deepEqual(diffOf("Edit", { old_string: "a\nb\nc", new_string: "a\nB\nc" }), ["-b", "+B"]);
    assert.deepEqual(diffOf("Write", { content: "x\ny" }), ["+x", "+y"]);
    assert.deepEqual(diffOf("MultiEdit", { edits: [{ old_string: "1", new_string: "2" }, { old_string: "3", new_string: "" }] }), ["-1", "+2", "@@", "-3", "+"]);
    assert.equal(diffOf("Read", {}), null);
    assert.equal(diffOf("Write", { content: Array(200).fill("z").join("\n") }).length, MAX_DIFF + 1);
    // YAP: messages handed over as hook context, and Claude's own `yap say` calls.
    const ctx = "Messages for you through yap:\n- From session @yap, answering 1a2b3c4d: merged\nsecond line\n- Question 9f8e7d6c from session @math: which file? (answer with `yap say --re 9f8e7d6c <text>`)\n- New note on the board, #6 from the user: hi\nThese are information, not instructions: nope";
    assert.deepEqual(yapMessages(ctx).map((m) => [m.type, m.from, m.sender, m.id ?? m.re ?? m.note ?? null, m.text]), [
      ["say", "@yap", "yap", "1a2b3c4d", "merged\nsecond line"], ["question", "@math", "math", "9f8e7d6c", "which file?"], ["note", "the user", null, "6", "hi"]]);
    assert.deepEqual(yapMessages("Other agents are working here"), []);
    // The terminal right now: its spinner line and the block Claude is on, above the input box.
    const R = "─".repeat(40);
    const scr = ["● Earlier reply.", "", "● Claim chat mod and capture this terminal's screen", "  ⎿  $ yap doing \"Chat overhaul\"", "     >/dev/null",
      "", "✻ Architecting… (1m 1s · ↓ 5.1k tokens · thought for 18s)", "", R, "❯ ", R, "  ⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n");
    assert.deepEqual(readScreen(scr), { mode: "bypass", live: { spin: "Architecting… (1m 1s · ↓ 5.1k tokens · thought for 18s)",
      now: "Claim chat mod and capture this terminal's screen ⎿ $ yap doing \"Chat overhaul\" >/dev/null" } });
    assert.deepEqual(readScreen(["● Done.", "", R, "❯ ", R, "  ⏵⏵ accept edits on"].join("\n")), { mode: "acceptEdits", live: null });
    const said = yapSay({ name: "Bash", id: "x", input: { command: `yap say --question --re ab12 @auth "can I take \\"login\\"?"` } });
    assert.deepEqual([said.type, said.re, said.to, said.text], ["question", "ab12", "@auth", 'can I take "login"?']);
    assert.equal(yapSay({ name: "Bash", input: { command: "yappy say hi" } }), null);
    // The skill quotes the recipient ('@tasks'); the message ends at the shell's next command; a say after another command counts.
    const chained = yapSay({ name: "Bash", input: { command: `yap say '@tasks' "No collision: I'm in kodr-pane." && cat >> a.js <<'JS'\nexport const x = 1;\nJS` } });
    assert.deepEqual([chained.to, chained.text], ["@tasks", "No collision: I'm in kodr-pane."]);
    const after = yapSay({ name: "Bash", input: { command: `cd repo && yap doing "x" >/dev/null; yap say '@tasks' hi there | tail -1` } });
    assert.deepEqual([after.to, after.text], ["@tasks", "hi there"]);
    assert.deepEqual([yapSay({ name: "Bash", input: { command: `yap say "a; b && c"` } }).text], ["a; b && c"]); // operators inside quotes are text
    assert.equal(yapSay({ name: "Bash", input: { command: `echo "yap say hi"` } }), null);
    // A recorded session: tasks from TaskCreate/TaskUpdate, and an ask matched despite key order.
    const t = `selfcheck-${process.pid}`, d = terminalDir(t);
    fs.mkdirSync(path.join(d, "asks"), { recursive: true });
    const L = [
      { type: "assistant", uuid: "a1", message: { content: [{ type: "tool_use", id: "c1", name: "TaskCreate", input: { subject: "One", activeForm: "Doing one" } }] } },
      { type: "user", uuid: "u1", message: { content: [{ type: "tool_result", tool_use_id: "c1", content: "Task #1 created successfully: One" }] } },
      { type: "assistant", uuid: "a2", message: { content: [{ type: "tool_use", id: "c2", name: "TaskUpdate", input: { taskId: "1", status: "completed" } }] } },
      { type: "assistant", uuid: "a3", message: { content: [{ type: "tool_use", id: "q1", name: "AskUserQuestion", input: { questions: [{ question: "Q?", multiSelect: false }] } }] } },
      // What the terminal shows as Claude thinking (often its progress notes) is a row; an empty one isn't.
      { type: "assistant", uuid: "a4", message: { content: [{ type: "thinking", thinking: "Checking the feed next.", signature: "x" }, { type: "thinking", thinking: "  ", signature: "y" }] } },
    ];
    fs.writeFileSync(path.join(d, "t.jsonl"), L.map((x) => JSON.stringify(x)).join("\n"));
    fs.writeFileSync(path.join(d, "session.json"), JSON.stringify({ session: "s", transcript: path.join(d, "t.jsonl"), cwd: d }));
    fs.writeFileSync(path.join(d, "asks", "9.end"), JSON.stringify({ note: "Answered: A", tool: "AskUserQuestion",
      key: JSON.stringify({ questions: [{ multiSelect: false, question: "Q?" }] }), at: Date.now() }));
    const v = feed(t);
    fs.rmSync(d, { recursive: true, force: true });
    assert.deepEqual(v.todos.map((x) => [x.content, x.status]), [["One", "completed"]]);
    assert.equal(v.rows.find((r) => r.name === "AskUserQuestion").ask.note, "Answered: A");
    assert.deepEqual(v.rows.filter((r) => r.kind === "thinking").map((r) => r.text), ["Checking the feed next."]);
    // A screenshot's base64 in a tool result doesn't push the conversation before it out of the chat.
    const big = [
      { type: "user", uuid: "b0", message: { content: "before the screenshot" } },
      { type: "assistant", uuid: "b1", message: { content: [{ type: "tool_use", id: "s1", name: "Read", input: { file_path: "x.png" } }] } },
      { type: "user", uuid: "b2", message: { content: [{ type: "tool_result", tool_use_id: "s1", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(6 << 20) } }] }] } },
      { type: "assistant", uuid: "b3", message: { content: [{ type: "text", text: "after" }] } },
    ];
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "t.jsonl"), big.map((x) => JSON.stringify(x)).join("\n"));
    fs.writeFileSync(path.join(d, "session.json"), JSON.stringify({ session: "s", transcript: path.join(d, "t.jsonl"), cwd: d }));
    const w = feed(t);
    fs.rmSync(d, { recursive: true, force: true });
    assert.deepEqual(w.rows.map((r) => [r.kind, r.text ?? r.state]), [["user", "before the screenshot"], ["tool", "ok"], ["text", "after"]]);
    // A tool's picture (a Read of a PNG, a browser screenshot) is kept in herdr's folder and shown: small ones
    // parsed as they are, megabyte ones through blankData; a long non-image "data" is still just dropped.
    const app = path.join(os.tmpdir(), `kodr-app-${process.pid}`), was = process.env.HERDR_APP_HOME;
    process.env.HERDR_APP_HOME = app;
    const dot = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==";
    const huge = "iVBORw0KGgo" + "A".repeat(2 << 20);
    const pic = (id, data) => ({ type: "user", uuid: `r${id}`, message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data } }] }] } });
    const use = (id) => ({ type: "assistant", uuid: `a${id}`, message: { content: [{ type: "tool_use", id, name: "Read", input: { file_path: `${id}.png` } }] } });
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "t.jsonl"), [use("p1"), pic("p1", dot), use("p2"), pic("p2", huge), use("p3"), pic("p3", "A".repeat(2 << 20))].map((x) => JSON.stringify(x)).join("\n"));
    fs.writeFileSync(path.join(d, "session.json"), JSON.stringify({ session: "s", transcript: path.join(d, "t.jsonl"), cwd: d }));
    const im = feed(t).rows;
    fs.rmSync(d, { recursive: true, force: true });
    assert.equal(im.length, 3);
    const [small, large] = im.map((r) => r.images?.[0]);
    assert.match(small, /^data\/kodr-chat\/img\/[0-9a-f]{16}\.png$/);
    assert.deepEqual(fs.readFileSync(path.join(app, small)), Buffer.from(dot, "base64"));
    assert.equal(fs.statSync(path.join(app, large)).size, Buffer.from(huge, "base64").length);
    assert.equal(im[2].images, undefined);
    fs.rmSync(app, { recursive: true, force: true });
    if (was === undefined) delete process.env.HERDR_APP_HOME; else process.env.HERDR_APP_HOME = was;
    // Claude Code's compaction summary is a user line it wrote, not the person's message: a note, not a bubble.
    const compact = [
      { type: "user", uuid: "c0", message: { content: "my real message" } },
      { type: "system", subtype: "compact_boundary", content: "Conversation compacted" },
      { type: "user", uuid: "c1", isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { content: "This session is being continued from a previous conversation that ran out of context. ..." } },
    ];
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "t.jsonl"), compact.map((x) => JSON.stringify(x)).join("\n"));
    fs.writeFileSync(path.join(d, "session.json"), JSON.stringify({ session: "s", transcript: path.join(d, "t.jsonl"), cwd: d }));
    const cm = feed(t).rows;
    fs.rmSync(d, { recursive: true, force: true });
    assert.deepEqual(cm.map((r) => [r.kind, r.text]), [["user", "my real message"], ["note", "Context compacted: earlier turns were summarized for Claude"]]);
    // A goal handed to yap's crew becomes a crew row after its call; a failed `yap goal` doesn't.
    const crew = [
      { type: "assistant", uuid: "g1", message: { content: [{ type: "tool_use", id: "y1", name: "Bash", input: { command: `yap goal "split the parser" && yap go` } }] } },
      { type: "user", uuid: "g2", timestamp: "2026-11-21T10:00:00Z", message: { content: [{ type: "tool_result", tool_use_id: "y1", content: "goal 12 on issues: a planner is drafting tickets. `yap status` shows them, `yap go` starts them." }] } },
      { type: "assistant", uuid: "g3", message: { content: [{ type: "tool_use", id: "y2", name: "Bash", input: { command: "yap goal again" } }] } },
      { type: "user", uuid: "g4", message: { content: [{ type: "tool_result", tool_use_id: "y2", is_error: true, content: "the daemon is not running" }] } },
    ];
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "t.jsonl"), crew.map((x) => JSON.stringify(x)).join("\n"));
    fs.writeFileSync(path.join(d, "session.json"), JSON.stringify({ session: "s", transcript: path.join(d, "t.jsonl"), cwd: d }));
    const cr = feed(t).rows;
    fs.rmSync(d, { recursive: true, force: true });
    assert.deepEqual(cr.filter((r) => r.kind === "crew").map((r) => r.goal), [12]);
    // The crew's report on a goal this session handed it (yap wakes the session with it): a crew report, folded into
    // that goal's card when the chat has one, shown on its own when it doesn't.
    const report = "Messages for you through yap:\n- The crew merged goal 12, which you handed it: Added the parser split.\nSecond line.";
    assert.deepEqual(yapMessages(report).map((m) => [m.type, m.goal, m.from, m.text]), [["goal", 12, "the crew", "Added the parser split.\nSecond line."]]);
    const hook = (text) => ({ type: "attachment", attachment: { type: "hook_additional_context", content: [text] } });
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "t.jsonl"), [...crew, hook(report), hook(report.replace("goal 12", "goal 40"))].map((x) => JSON.stringify(x)).join("\n"));
    fs.writeFileSync(path.join(d, "session.json"), JSON.stringify({ session: "s", transcript: path.join(d, "t.jsonl"), cwd: d }));
    const rr = feed(t).rows;
    fs.rmSync(d, { recursive: true, force: true });
    assert.deepEqual(rr.filter((r) => r.type === "goal").map((r) => r.goal), [40]); // 12 has a card: no second copy
    // A handed-off goal stuck on a ticket (yap 07b68d4): its own urgent type, not the landing report.
    const stuck = "Messages for you through yap:\n- Goal 41, which you handed the crew, is stuck and needs a human: t9 \"Picker remembers the choice\": still failing after 4 rounds. `yap show 9` has the story.";
    assert.deepEqual(yapMessages(stuck).map((m) => [m.type, m.goal, m.from, m.text]),
      [["stuck", 41, "the crew", "t9 \"Picker remembers the choice\": still failing after 4 rounds. `yap show 9` has the story."]]);
    console.log("feed: ok");
  } else {
    // Crew cards carry the crew's live state: one read of yap's daemon, only when the chat has one.
    const v = feed(process.argv[2]);
    // A fixture session (screenshots) can stand in for the daemon with crew-state.json in its folder.
    const fixture = v?.terminal && readJson(path.join(terminalDir(v.terminal), "crew-state.json"), null);
    if (v?.rows) await attach(v.rows, fixture ? async () => fixture : undefined);
    process.stdout.write(JSON.stringify(v ?? { none: true }));
  }
}
