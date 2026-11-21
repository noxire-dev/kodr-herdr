#!/usr/bin/env node
// Claude Code hooks for sessions started with Kodr's --settings, inside a herdr terminal.
//   session  (SessionStart)       maps the terminal to its session and transcript
//   ask      (PermissionRequest)  puts the request on the chat card and waits for its answer;
//                                 Claude's own prompt stays answerable in the terminal meanwhile
//   end      (SessionEnd)          marks the session ended, so the pane stops offering its chat
//   stop     (Stop)               checkpoints the turn and starts the checks in the background; starts the next
//                                 review round when the card's findings were sent to this Claude (lib/store roundDue)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkpoint } from "../lib/checkpoint.mjs";
import { terminalDir, readJson, writeJson, lastUuid, roundDue } from "../lib/store.mjs";

const event = process.argv[2];
const t = process.env.HC_TERMINAL_ID;
if (!t || /[\\/]|\.\./.test(t)) process.exit(0);
// A Claude a tool started inside this terminal (claude -p, the SDK) inherits its HC_TERMINAL_ID. It isn't the
// terminal's Claude: left in, it would take over the chat, its turns and its permission cards.
if (/^sdk/.test(process.env.CLAUDE_CODE_ENTRYPOINT ?? "")) process.exit(0);
const dir = terminalDir(t);
let input = {};
try { input = JSON.parse(fs.readFileSync(0, "utf8") || "{}"); } catch {}

const head = (cwd) => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};

if (event === "session") {
  const file = path.join(dir, "session.json");
  const prev = readJson(file, null);
  const same = prev?.session === input.session_id;
  writeJson(file, { session: input.session_id, transcript: input.transcript_path, cwd: input.cwd, base: same ? prev.base : head(input.cwd) });
  if (!same) for (const f of ["turns.json", "reviewed"]) fs.rmSync(path.join(dir, f), { force: true });
  // Kodr's todo board (Mission shows it): how this agent adds to it.
  const todo = `node "${fileURLToPath(new URL("../feed/kodr-todo.mjs", import.meta.url)).replace(/\\/g, "/")}"`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext:
    `Kodr Mission has a todo board for this repo that the person watches. For work bigger than one turn, put it there: ` +
    `${todo} add "<title>" [--body "<details>"], then start <id> when you begin, note <id> "<progress>", block <id> "<why>", done <id>. ` +
    `${todo} list shows the open ones; pick up one that fits before adding a duplicate.` +
    // With yap installed: its crew is the way to split work across agents (the chat shows the goal as a card).
    (fs.existsSync(path.join(process.env.YAP_HOME ?? path.join(os.homedir(), ".yap"), "token"))
      ? ` When a task splits into independent pieces that each deserve their own agent, review and merge, hand it to yap's crew: ` +
        `yap goal "<goal>" (a planner drafts tickets), then yap go to start them; the chat shows its progress and report.`
      : "") } }));
} else if (event === "end") {
  const file = path.join(dir, "session.json");
  const prev = readJson(file, null);
  if (prev && prev.session === input.session_id) writeJson(file, { ...prev, ended: Date.now() });
} else if (event === "ask") {
  await ask();
} else if (event === "stop") {
  stop();
}

async function ask() {
  const id = `${Date.now()}-${process.pid}`;
  const asks = path.join(dir, "asks");
  const req = path.join(asks, `${id}.req.json`), ans = path.join(asks, `${id}.ans.json`), end = path.join(asks, `${id}.end`);
  writeJson(req, { id, tool: input.tool_name, input: input.tool_input ?? {}, at: Date.now() });
  // The note the chat shows on the tool once this ask is over, matched to the call by its input.
  const finish = (note, declined = false) => {
    if (note) writeJson(end, { note, declined, tool: input.tool_name, key: JSON.stringify(input.tool_input ?? {}), at: Date.now() });
    fs.rmSync(req, { force: true });
    fs.rmSync(ans, { force: true });
    process.exit(0);
  };
  // Claude ends the hook itself when its prompt is answered or refused in the terminal.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => finish("Answered in the terminal"));
  const hc = process.env.KODR_HC || readJson(path.join(os.homedir(), ".kodr-herdr", "config.json"), {}).hc || "hc";
  const status = () => {
    try {
      const r = JSON.parse(execFileSync(hc, ["get", t, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
      return r.state === "live" ? (typeof r.status === "object" ? r.status?.state : r.status) ?? "" : "gone";
    } catch { return ""; }
  };
  let armed = false, polls = 0;
  const deadline = Date.now() + 30 * 60_000;
  for (;;) {
    if (fs.existsSync(ans)) {
      const out = fs.readFileSync(ans, "utf8");
      process.stdout.write(out);
      let d = {};
      try { d = JSON.parse(out).hookSpecificOutput?.decision ?? {}; } catch {}
      const answers = d.updatedInput?.answers;
      finish(d.behavior === "deny" ? (input.tool_name === "ExitPlanMode" ? "Kept planning" : "Declined in chat")
        : answers ? `Answered: ${Object.values(answers).join(", ")}`
        : input.tool_name === "ExitPlanMode" ? "Plan approved" : "Allowed in chat", d.behavior === "deny");
    }
    // ponytail: hc every ~1.2 s; an answer file is seen within 300 ms either way.
    if (++polls % 4 === 0) {
      const s = status();
      if (s === "blocked") armed = true;
      else if (s === "gone") finish("Agent stopped");
      else if (armed && s) finish("Answered in the terminal");
    }
    if (Date.now() > deadline) finish("No answer in 30 minutes; answer in the terminal");
    await new Promise((r) => setTimeout(r, 300));
  }
}

function stop() {
  const s = readJson(path.join(dir, "session.json"), null);
  const due = roundDue(input.cwd ?? s?.cwd ?? ".", t);
  if (due) {
    const mission = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "feed", "kodr-mission.mjs");
    const env = { ...process.env };
    delete env.HC_TERMINAL_ID;
    spawn(process.execPath, [mission, "review", due.wt, String(due.n), "--auto"], { detached: true, stdio: "ignore", windowsHide: true, env }).unref();
  }
  if (!s?.cwd) return;
  const file = path.join(dir, "turns.json");
  const turns = readJson(file, { turns: [] }).turns;
  const last = turns.at(-1);
  let cp = null;
  try { cp = checkpoint(s.cwd, { session: s.session, turn: turns.length + 1, scratch: dir, previous: last?.sha }); } catch {}
  // A turn that changed nothing since the last checkpoint isn't a new thing to review.
  if (!cp?.stat) return;
  turns.push({ n: turns.length + 1, sha: cp.sha, stat: cp.stat, at: Date.now(), anchor: lastUuid(input.transcript_path ?? s.transcript), checks: s.base ? "running" : null });
  writeJson(file, { turns });
  if (s.base) {
    const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "kodr-verify.mjs");
    spawn(process.execPath, [runner, t, cp.sha], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  }
}
