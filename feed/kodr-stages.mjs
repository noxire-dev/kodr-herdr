#!/usr/bin/env node
// What stage each agent is at, for the agents list (mod/kodr-agents):
//   node feed/kodr-stages.mjs <terminal>...   → { "<terminal>": { stage, done, total } }
// stage: the task Claude marked in progress (its activeForm), else the session's `yap doing` line, else null.
// done/total: its task list (lib/tasks.mjs). A terminal with neither is left out.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, terminalDir } from "../lib/store.mjs";
import { readTasks } from "../lib/tasks.mjs";

/** One terminal's stage from its task list and yap doing line. */
export function stageOf(tasks, doing) {
  const now = tasks.find((x) => x.status === "in_progress");
  const done = tasks.filter((x) => x.status === "completed").length;
  const stage = (now && (now.activeForm || now.content)) || doing || null;
  return stage || tasks.length ? { stage, done, total: tasks.length } : null;
}

/** `yap doing` per terminal, from the daemon (one call for every repo); {} when yap isn't running. */
async function doingByTerminal() {
  try {
    const token = fs.readFileSync(path.join(process.env.YAP_HOME ?? path.join(os.homedir(), ".yap"), "token"), "utf8").trim();
    const res = await fetch(`http://127.0.0.1:${process.env.YAP_PORT ?? 4170}/api/sessions`, { headers: { "x-yap-token": token }, signal: AbortSignal.timeout(1500) });
    const list = res.ok ? await res.json() : [];
    // Newest last, so a terminal's latest session wins.
    return Object.fromEntries(list.filter((s) => s.terminal && s.doing).sort((a, b) => a.at - b.at).map((s) => [s.terminal, s.doing]));
  } catch {
    return {};
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--self-check") {
    const assert = (await import("node:assert/strict")).default;
    const T = (content, status, activeForm) => ({ content, status, activeForm });
    assert.deepEqual(stageOf([T("Write tests", "completed"), T("Fix the parser", "in_progress", "Fixing the parser"), T("Ship", "pending")], "parser work"),
      { stage: "Fixing the parser", done: 1, total: 3 });
    // No task in progress: the doing line, still with the count.
    assert.deepEqual(stageOf([T("a", "completed"), T("b", "pending")], "between tasks"), { stage: "between tasks", done: 1, total: 2 });
    // In progress without an activeForm: its subject.
    assert.deepEqual(stageOf([T("Plain", "in_progress")], ""), { stage: "Plain", done: 0, total: 1 });
    assert.deepEqual(stageOf([], "only yap"), { stage: "only yap", done: 0, total: 0 });
    assert.deepEqual(stageOf([T("a", "completed")], ""), { stage: null, done: 1, total: 1 });
    assert.equal(stageOf([], ""), null);
    console.log("kodr-stages: ok");
  } else {
    const doing = await doingByTerminal();
    const out = {};
    for (const t of process.argv.slice(2)) {
      if (!/^[\w.-]+$/.test(t)) continue;
      const s = readJson(path.join(terminalDir(t), "session.json"), null);
      const st = stageOf(readTasks(s?.transcript), doing[t] ?? "");
      if (st) out[t] = st;
    }
    // No process.exit: right after fetch() it trips a libuv assert on Windows.
    process.stdout.write(JSON.stringify(out));
  }
}
