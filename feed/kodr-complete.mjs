#!/usr/bin/env node
// What the chat composer can complete, for one terminal's session (JSON on stdout):
//   commands: built-in slash commands, the person's and the project's commands and skills, and
//             installed plugins' skills and commands ({ name, desc, kind })
//   files:    the project's files (git ls-files), for @ mentions
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { terminalDir, readJson } from "../lib/store.mjs";

const BUILTIN = [
  ["clear", "Start a new conversation"],
  ["compact", "Summarize the conversation to free context"],
  ["context", "Show what is using the context window"],
  ["model", "Switch the model"],
  ["cost", "Show this session's cost and usage"],
  ["usage", "Show plan usage limits"],
  ["review", "Review a pull request"],
  ["init", "Write a CLAUDE.md for this project"],
  ["memory", "Edit memory files"],
  ["agents", "Manage subagents"],
  ["mcp", "Manage MCP servers"],
  ["permissions", "Manage tool permissions"],
  ["rewind", "Go back to an earlier point"],
  ["resume", "Resume an earlier session"],
  ["export", "Export the conversation"],
  ["status", "Show version, model and account"],
  ["help", "Show help"],
];

// The first "description:" in a markdown file's front matter.
function describe(file) {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 4000);
    const m = /^---[\s\S]*?^description:\s*["']?(.+?)["']?\s*$/m.exec(head);
    return m ? m[1].slice(0, 140) : "";
  } catch { return ""; }
}

function scan(base, prefix, out) {
  const skills = path.join(base, "skills"), commands = path.join(base, "commands");
  try {
    for (const d of fs.readdirSync(skills)) {
      const f = path.join(skills, d, "SKILL.md");
      if (fs.existsSync(f)) out.push({ name: prefix + d, desc: describe(f), kind: "skill" });
    }
  } catch {}
  try {
    for (const f of fs.readdirSync(commands)) if (f.endsWith(".md")) out.push({ name: prefix + f.slice(0, -3), desc: describe(path.join(commands, f)), kind: "command" });
  } catch {}
}

export function complete(t) {
  const s = readJson(path.join(terminalDir(t), "session.json"), null);
  const commands = BUILTIN.map(([name, desc]) => ({ name, desc, kind: "built-in" }));
  if (s?.cwd) scan(path.join(s.cwd, ".claude"), "", commands);
  const claude = path.join(os.homedir(), ".claude");
  scan(claude, "", commands);
  const plugins = readJson(path.join(claude, "plugins", "installed_plugins.json"), { plugins: {} }).plugins ?? {};
  for (const [id, installs] of Object.entries(plugins)) {
    const p = installs?.[0]?.installPath;
    if (p) scan(p, `${id.split("@")[0]}:`, commands);
  }
  const seen = new Set();
  const unique = commands.filter((c) => !seen.has(c.name) && seen.add(c.name));
  let files = [];
  if (s?.cwd) {
    try {
      files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: s.cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
        .split("\n").filter(Boolean).slice(0, 5000);
    } catch {}
  }
  return { commands: unique, files };
}

process.stdout.write(JSON.stringify(complete(process.argv[2]) ?? { commands: [], files: [] }));
