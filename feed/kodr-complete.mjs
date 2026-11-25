#!/usr/bin/env node
// What the chat composer can complete, for one terminal's session (JSON on stdout):
//   commands: built-in slash commands, the person's and the project's commands and skills, and
//             installed plugins' skills and commands ({ name, desc, kind })
//   files:    the project's files (git ls-files), for @ mentions
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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

// Skills Claude Code ships with: they have no SKILL.md on disk.
const BUNDLED = [
  ["simplify", "Review the changed code for reuse and simplification, then fix it"],
  ["code-review", "Review the current diff for correctness bugs"],
  ["security-review", "Review the pending changes for security issues"],
  ["loop", "Run a prompt or command on a recurring interval"],
  ["schedule", "Create or manage scheduled cloud agents"],
  ["run", "Launch the project's app to see a change working"],
  ["claude-api", "Reference for the Claude API and Anthropic SDK"],
  ["update-config", "Configure Claude Code through settings.json"],
  ["keybindings-help", "Customize keyboard shortcuts"],
  ["fewer-permission-prompts", "Allowlist the read-only commands you keep approving"],
];

// A field ("description", "name") of a markdown file's front matter.
function front(file, field) {
  try {
    const head = fs.readFileSync(file, "utf8").slice(0, 4000);
    const m = new RegExp(`^---[\\s\\S]*?^${field}:[ \\t]*["']?(.*?)["']?[ \\t]*$((?:\\r?\\n[ \\t]+.*)*)`, "m").exec(head);
    if (!m) return "";
    // A YAML block (description: > or |) is the indented lines under it.
    const v = !m[1] || /^[>|][-+]?$/.test(m[1]) ? m[2].split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(" ") : m[1];
    return v.slice(0, 140);
  } catch { return ""; }
}

// A skill folder (has SKILL.md), or a folder of them (one level, as Claude reads them).
function skillsIn(dir, prefix, out, top = true) {
  const f = path.join(dir, "SKILL.md");
  if (fs.existsSync(f)) {
    out.push({ name: prefix + (front(f, "name") || path.basename(dir)), desc: front(f, "description"), kind: "skill" });
    return;
  }
  if (!top) return;
  let ds = [];
  try { ds = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const d of ds) if (d.isDirectory() || d.isSymbolicLink()) skillsIn(path.join(dir, d.name), prefix, out, false);
}

function commandsIn(p, prefix, out) {
  let files = [];
  try { files = fs.statSync(p).isDirectory() ? fs.readdirSync(p).map((f) => path.join(p, f)) : [p]; } catch { return; }
  for (const f of files) if (f.endsWith(".md") && !path.basename(f).startsWith("_")) out.push({ name: prefix + path.basename(f, ".md"), desc: front(f, "description"), kind: "command" });
}

function scan(base, prefix, out, manifest = {}) {
  skillsIn(path.join(base, "skills"), prefix, out);
  commandsIn(path.join(base, "commands"), prefix, out);
  // A plugin's manifest can list more skill and command paths than the default folders.
  const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).map((r) => path.resolve(base, r));
  for (const d of list(manifest.skills)) skillsIn(d, prefix, out);
  for (const c of list(manifest.commands)) commandsIn(c, prefix, out);
}

// Plugins switched off in any settings file Claude reads stay out of the menus.
function disabled(cwd) {
  const off = new Set();
  const files = [path.join(os.homedir(), ".claude", "settings.json")];
  if (cwd) files.push(path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json"));
  for (const f of files) for (const [id, on] of Object.entries(readJson(f, {})?.enabledPlugins ?? {})) on === false ? off.add(id) : off.delete(id);
  return off;
}

export function complete(t) {
  const s = readJson(path.join(terminalDir(t), "session.json"), null);
  const commands = BUILTIN.map(([name, desc]) => ({ name, desc, kind: "built-in" }));
  const bundled = BUNDLED.map(([name, desc]) => ({ name, desc, kind: "skill" }));
  if (s?.cwd) scan(path.join(s.cwd, ".claude"), "", commands);
  const claude = path.join(os.homedir(), ".claude");
  scan(claude, "", commands);
  // Skills synced from claude.ai: ~/.claude/skills/synced/<account>/<skill>, named anthropic-skills:<skill>.
  try { for (const a of fs.readdirSync(path.join(claude, "skills", "synced"))) skillsIn(path.join(claude, "skills", "synced", a), "anthropic-skills:", commands); } catch {}
  const plugins = readJson(path.join(claude, "plugins", "installed_plugins.json"), { plugins: {} }).plugins ?? {};
  const off = disabled(s?.cwd);
  for (const [id, installs] of Object.entries(plugins)) {
    const p = installs?.at(-1)?.installPath;
    if (!p || off.has(id)) continue;
    const manifest = readJson(path.join(p, ".claude-plugin", "plugin.json"), {}) ?? {};
    scan(p, `${manifest.name || id.split("@")[0]}:`, commands, manifest);
  }
  commands.push(...bundled);
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

if (process.argv[2] === "--self-check") {
  // A scratch home: a nested skill its plugin's manifest lists, a folded description, a disabled plugin, a synced
  // skill, and a "_" file that isn't a command.
  const { strict: assert } = await import("node:assert");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-complete-"));
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true }); fs.writeFileSync(path.join(home, rel), text); };
  put("p/on/.claude-plugin/plugin.json", JSON.stringify({ name: "pon", skills: ["./skills/group/deep"] }));
  put("p/on/skills/group/deep/SKILL.md", "---\nname: deep\ndescription: >\n  Folded over\n  two lines.\n---\n");
  put("p/on/skills/flat/SKILL.md", "---\r\ndescription: \"Flat one\"\r\n---\r\n");
  put("p/on/commands/go.md", "---\ndescription: Go\n---\n");
  put("p/on/commands/_notes.md", "");
  put("p/off/skills/hidden/SKILL.md", "---\ndescription: x\n---\n");
  put(".claude/plugins/installed_plugins.json", JSON.stringify({ plugins: {
    "on@m": [{ installPath: path.join(home, "p", "on") }], "off@m": [{ installPath: path.join(home, "p", "off") }] } }));
  put(".claude/settings.json", JSON.stringify({ enabledPlugins: { "off@m": false } }));
  put(".claude/skills/synced/acct/pdf/SKILL.md", "---\ndescription: PDFs\n---\n");
  const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), "none"], { env: { ...process.env, USERPROFILE: home, HOME: home }, encoding: "utf8" });
  const by = Object.fromEntries(JSON.parse(out).commands.map((c) => [c.name, c]));
  assert.equal(by["pon:deep"]?.desc, "Folded over two lines.");
  assert.equal(by["pon:flat"]?.desc, "Flat one");
  assert.equal(by["pon:go"]?.kind, "command");
  assert.ok(!by["pon:_notes"] && !Object.keys(by).some((n) => n.includes("hidden")));
  assert.equal(by["anthropic-skills:pdf"]?.desc, "PDFs");
  assert.equal(by.simplify?.kind, "skill");
  fs.rmSync(home, { recursive: true, force: true });
  console.log("kodr-complete: ok");
} else process.stdout.write(JSON.stringify(complete(process.argv[2]) ?? { commands: [], files: [] }));
