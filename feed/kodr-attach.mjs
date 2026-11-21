#!/usr/bin/env node
// Lets the chat show a Claude Code that wasn't started with Kodr's settings: finds the session
// from the terminal's Claude process (~/.claude/sessions/<pid>.json) and writes the terminal's
// session.json, as the SessionStart hook would. Chat only: permission cards, checkpoints and
// checks need the hooks (Claude (Kodr) in herdr's + menu). Prints {"ok":true} or {"error":"…"}.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { terminalDir, readJson, writeJson, transcriptOf, claudeProcess } from "../lib/store.mjs";
import os from "node:os";

const t = process.argv[2];
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
if (!t || /[\\/]|\.\./.test(t)) out({ error: "no terminal" });

const hc = readJson(path.join(os.homedir(), ".kodr-herdr", "config.json"), {}).hc ?? "hc";
let term;
try { term = JSON.parse(execFileSync(hc, ["get", t, "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })); } catch { out({ error: "herdr doesn't know this terminal" }); }
const pid = term.foreground?.pid;
const proc = pid && claudeProcess(pid);
if (!proc?.sessionId) out({ error: "No Claude Code session is running in this terminal" });
// A session nobody has talked to yet has no file: use where Claude will write it (its project
// folder is the cwd with every other character turned into "-"), and the chat starts empty.
const transcript = transcriptOf(proc.sessionId) ??
  path.join(os.homedir(), ".claude", "projects", String(proc.cwd).replace(/[^A-Za-z0-9]/g, "-"), `${proc.sessionId}.jsonl`);

const file = path.join(terminalDir(t), "session.json");
const prev = readJson(file, null);
let base = prev?.session === proc.sessionId ? prev.base : null;
if (!base) {
  try { base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: proc.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
}
writeJson(file, { session: proc.sessionId, transcript, cwd: proc.cwd, base, pid, attached: true });
out({ ok: true });
