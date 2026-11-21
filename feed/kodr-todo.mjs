#!/usr/bin/env node
// Kodr's own todo board, one per repo, kept on this machine: no GitHub, no Rinai, and a folder that isn't a git repo works
// too. Agents add and move their own todos; Mission shows them. A repo's board is keyed by its main checkout, so its
// worktrees share it. Stored in ~/.kodr-herdr/boards/<name>-<hash>.json.
//   add <title> [--body text] [--column c]    "Added #3: …"     (column: todo, ongoing, in-review, blocked, done; default todo)
//   list [--all]                               open todos, one a line (--all: Done too)
//   show <id>
//   move <id> <column> | start <id> | done <id> | block <id> [why]
//   note <id> <text>                           appends a line to its notes
//   edit <id> [--title t] [--body b]
//   rm <id>
//   --cwd <dir>   the repo (default: the current folder)      --json   answers as JSON (Mission uses it)
//   --by <terminal>   who did it, when it isn't this terminal (Mission's Start)
//   --self-check
// An agent in a Kodr terminal is recorded as the todo's author (HC_TERMINAL_ID), so Mission can take you to it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const COLUMNS = ["todo", "ongoing", "in-review", "blocked", "done"];
const boards = () => path.join(process.env.KODR_HOME ?? path.join(os.homedir(), ".kodr-herdr"), "boards");

/** The folder a board belongs to: the main checkout of the git repo `cwd` is in, else `cwd` itself. */
export function repoKey(cwd) {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return path.resolve(common.endsWith("/.git") || common.endsWith("\\.git") ? common.slice(0, -5) : common);
  } catch {
    return path.resolve(cwd);
  }
}

export function boardFile(key) {
  const id = crypto.createHash("sha1").update(key.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 10);
  return path.join(boards(), `${path.basename(key).replace(/[^\w.-]+/g, "-") || "root"}-${id}.json`);
}

const read = (file, key) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { key, next: 1, cards: [] }; } };

// Several agents write at once: one writer at a time through a lock file, a stale one (a crashed writer) taken over.
// ponytail: busy-wait lock; fine for a handful of agents, a daemon if it ever isn't.
function locked(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  for (let i = 0; ; i++) {
    try { fs.closeSync(fs.openSync(lock, "wx")); break; } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) { fs.rmSync(lock, { force: true }); continue; } } catch {}
      if (i > 200) throw new Error("The board is locked by another writer.");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    const out = fn();
    fs.writeFileSync(tmp, JSON.stringify(out.board, null, 1));
    fs.renameSync(tmp, file);
    return out.answer;
  } finally { fs.rmSync(lock, { force: true }); }
}

/** Applies one verb to a board (pure but for `now`): { board, answer } or throws with what to do. */
export function apply(board, verb, args, { by = null, now = Date.now() } = {}) {
  const b = structuredClone(board);
  const find = (id) => {
    const c = b.cards.find((x) => x.id === Number(String(id ?? "").replace(/^[#Tt]+/, "")));
    if (!c) throw new Error(`No todo #${id ?? "?"} on this board. \`list\` shows them.`);
    return c;
  };
  const column = (c) => {
    const k = { review: "in-review", doing: "ongoing", "in-progress": "ongoing" }[c] ?? c;
    if (!COLUMNS.includes(k)) throw new Error(`Column is one of ${COLUMNS.join(", ")}.`);
    return k;
  };
  const touch = (c, patch) => Object.assign(c, patch, { updated: now, ...(by ? { by: c.by ?? by, last: by } : {}) });
  if (verb === "add") {
    const title = args.text.trim().split(/\r?\n/)[0].slice(0, 200);
    if (!title) throw new Error("Say what the todo is: add <title>.");
    const c = { id: b.next++, title, body: args.body ?? "", column: column(args.column ?? "todo"), at: now, updated: now, ...(by ? { by } : {}) };
    b.cards.push(c);
    return { board: b, answer: c };
  }
  if (verb === "move" || verb === "start" || verb === "done" || verb === "block") {
    const c = find(args.id);
    const col = verb === "move" ? column(args.column) : { start: "ongoing", done: "done", block: "blocked" }[verb];
    touch(c, { column: col, ...(verb === "start" && by ? { owner: by } : {}) });
    if (verb === "block" && args.text) c.notes = [...(c.notes ?? []), { at: now, text: `Blocked: ${args.text}`, ...(by ? { by } : {}) }];
    return { board: b, answer: c };
  }
  if (verb === "note") {
    const c = find(args.id);
    if (!args.text.trim()) throw new Error("note <id> <text>");
    touch(c, { notes: [...(c.notes ?? []), { at: now, text: args.text.trim(), ...(by ? { by } : {}) }] });
    return { board: b, answer: c };
  }
  if (verb === "edit") {
    const c = find(args.id);
    touch(c, { ...(args.title ? { title: args.title.trim().slice(0, 200) } : {}), ...(args.body != null ? { body: args.body } : {}) });
    return { board: b, answer: c };
  }
  if (verb === "rm") {
    const c = find(args.id);
    b.cards = b.cards.filter((x) => x !== c);
    return { board: b, answer: { removed: c.id } };
  }
  throw new Error(`Unknown verb ${verb}.`);
}

const line = (c) => `#${c.id} [${c.column}] ${c.title}`;
const showText = (c) => [line(c), c.body, ...(c.notes ?? []).map((n) => `- ${new Date(n.at).toISOString().slice(0, 16).replace("T", " ")} ${n.text}`)].filter(Boolean).join("\n");

function parse(argv) {
  const o = { words: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--all") o[a.slice(2)] = true;
    else if (["--cwd", "--body", "--column", "--title", "--by"].includes(a)) o[a.slice(2)] = argv[++i] ?? "";
    else o.words.push(a);
  }
  return o;
}

function run(argv) {
  const o = parse(argv);
  const [verb = "list", ...rest] = o.words;
  const key = repoKey(o.cwd ?? process.cwd());
  const file = boardFile(key);
  const say = (json, text) => process.stdout.write((o.json ? JSON.stringify(json) : text) + "\n");
  try {
    if (verb === "list" || verb === "board") {
      const b = read(file, key);
      const cards = b.cards.filter((c) => o.all || o.json || c.column !== "done");
      return say({ key, name: path.basename(key), cards: b.cards }, cards.length ? cards.map(line).join("\n") : "No open todos. Add one: add <title>");
    }
    if (verb === "show") {
      const c = read(file, key).cards.find((x) => x.id === Number(String(rest[0]).replace(/^[#Tt]+/, "")));
      return c ? say(c, showText(c)) : say({ error: `No todo #${rest[0]}.` }, `No todo #${rest[0]}.`);
    }
    // --by: Mission starting a todo for the agent it just opened.
    const t = o.by || process.env.HC_TERMINAL_ID;
    const by = t && /^[\w.-]+$/.test(t) ? t : null;
    const [id, ...more] = rest;
    const args = verb === "add" ? { text: rest.join(" "), body: o.body, column: o.column }
      : verb === "move" ? { id, column: more[0] } : { id, text: more.join(" "), title: o.title, body: o.body };
    const c = locked(file, () => apply(read(file, key), verb, args, { by }));
    const words = { add: "Added", move: "Moved", start: "Started", done: "Done:", block: "Blocked", note: "Noted on", edit: "Edited", rm: "Removed" };
    say(c, c.removed ? `Removed #${c.removed}.` : `${words[verb]} ${line(c)}`);
  } catch (e) {
    say({ error: e.message }, e.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "--self-check") run(process.argv.slice(2));
  else {
    const assert = (await import("node:assert/strict")).default;
    let b = { key: "/r", next: 1, cards: [] };
    const step = (verb, args, by = "t1") => { const r = apply(b, verb, args, { by, now: 100 }); b = r.board; return r.answer; };
    assert.equal(step("add", { text: "Write tests\nignored second line" }).id, 1);
    assert.equal(step("add", { text: "Ship", column: "review" }).column, "in-review");
    assert.throws(() => step("add", { text: "  " }), /Say what/);
    assert.throws(() => step("add", { text: "x", column: "later" }), /Column is one of/);
    assert.deepEqual([b.cards[0].title, b.cards[0].by, b.next], ["Write tests", "t1", 3]);
    assert.equal(step("start", { id: "#1" }, "t2").owner, "t2");
    assert.equal(b.cards[0].by, "t1", "the author stays");
    assert.equal(step("block", { id: 1, text: "needs a key" }).notes.at(-1).text, "Blocked: needs a key");
    assert.equal(step("note", { id: 2, text: "PR opened" }).notes.length, 1);
    assert.equal(step("edit", { id: 2, title: "Ship it" }).title, "Ship it");
    assert.throws(() => step("done", { id: 9 }), /No todo #9/);
    step("rm", { id: 1 });
    assert.deepEqual(b.cards.map((c) => c.id), [2]);
    // The pure step never changes the board it was given.
    const before = JSON.stringify(b); apply(b, "done", { id: 2 }); assert.equal(JSON.stringify(b), before);
    // The CLI end to end in a scratch home: a non-git folder works, two writers at once both land.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-todo-"));
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-todo-repo-"));
    const env = { ...process.env, KODR_HOME: home, HC_TERMINAL_ID: "tx" };
    const cli = (...a) => execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--cwd", folder, ...a], { env, encoding: "utf8" }).trim();
    const { spawn } = await import("node:child_process");
    await Promise.all(["one", "two", "three", "four"].map((w) => new Promise((ok) =>
      spawn(process.execPath, [fileURLToPath(import.meta.url), "--cwd", folder, "add", w], { env }).on("exit", ok))));
    const board = JSON.parse(cli("board", "--json"));
    assert.deepEqual(board.cards.map((c) => c.title).sort(), ["four", "one", "three", "two"]);
    assert.deepEqual(board.cards.map((c) => c.id).sort(), [1, 2, 3, 4]);
    assert.equal(board.cards[0].by, "tx");
    assert.match(cli("done", "2"), /^Done: #2 \[done\]/);
    assert.ok(!cli("list").includes("#2 "), "list leaves Done out");
    assert.ok(cli("list", "--all").includes("#2 "));
    assert.equal(JSON.parse(cli("show", "9", "--json")).error, "No todo #9.");
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(folder, { recursive: true, force: true });
    console.log("kodr-todo: ok");
  }
}
