#!/usr/bin/env node
// Installs Kodr into herdr-app: the mods, the theme, and Kodr's Claude hooks.
//   node bin/install.mjs           hooks in ~/.kodr-herdr/claude-settings.json, for Claude (Kodr) only
//   node bin/install.mjs --global  hooks in ~/.claude/settings.json (backed up first), so every Claude
//                                  started in herdr gets them; outside herdr they exit at once
//   node bin/install.mjs --local   moves them back out of ~/.claude/settings.json
//   node bin/install.mjs --uninstall  takes Kodr out of herdr and ~/.claude/settings.json; ~/.kodr-herdr stays
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..").replace(/\\/g, "/");
const home = path.join(os.homedir(), ".kodr-herdr");
const app = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app");
const node = process.execPath.replace(/\\/g, "/");

function which(cmd) {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim();
  } catch { return null; }
}
const herdrApp = which("herdr-app") ?? (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "herdr-app", "herdr-app.exe")) ?? "herdr-app";
const hc = which("hc") ?? (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "herdr-core", "hc.exe")) ?? "hc";

const hook = (event, timeout) => ({ type: "command", command: `"${node}" "${root}/hooks/kodr-hook.mjs" ${event}`, timeout });
const HOOKS = {
  SessionStart: [{ hooks: [hook("session", 10)] }],
  PermissionRequest: [{ hooks: [hook("ask", 1800)] }],
  Stop: [{ hooks: [hook("stop", 60)] }],
  SessionEnd: [{ hooks: [hook("end", 10)] }],
};
const isKodr = (entry) => (entry.hooks ?? []).some((h) => String(h.command ?? "").includes("kodr-hook.mjs"));
const MODS = ["kodr-chat", "kodr-review", "kodr-pane", "kodr-sessions", "kodr-mission", "kodr-tabs", "kodr-preview", "kodr-agents"];
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };

// Out again: the hooks from Claude's settings (backed up), Kodr's mods, theme, layout, menu entry and keys from
// herdr. Your own layouts, keys and programs stay; so does ~/.kodr-herdr (Kodr's state; delete it yourself).
if (process.argv.includes("--uninstall")) {
  const file = path.join(os.homedir(), ".claude", "settings.json"), claude = readJson(file);
  if (claude && Object.values(claude.hooks ?? {}).some((list) => list.some(isKodr))) {
    const hooks = Object.fromEntries(Object.entries(claude.hooks).map(([k, list]) => [k, list.filter((e) => !isKodr(e))]).filter(([, list]) => list.length));
    fs.copyFileSync(file, `${file}.kodr-backup-${Date.now()}`);
    fs.writeFileSync(file, JSON.stringify({ ...claude, hooks }, null, 2));
  }
  for (const mod of MODS) fs.rmSync(path.join(app, "mods", mod), { recursive: true, force: true });
  fs.rmSync(path.join(app, "themes", "kodr-zed.json"), { force: true });
  fs.rmSync(path.join(app, "layouts", "kodr.json"), { force: true });
  const programs = readJson(path.join(app, "programs.json"));
  if (programs?.programs?.["claude-kodr"]) { delete programs.programs["claude-kodr"]; fs.writeFileSync(path.join(app, "programs.json"), JSON.stringify(programs, null, 2)); }
  const keys = readJson(path.join(app, "keys.json")), kodr = keys?.["layout:kodr"];
  if (kodr) {
    for (const [k, v] of Object.entries(kodr)) if (/^(kodr-|mod.open:kodr-)/.test(String(v))) delete kodr[k];
    if (!Object.keys(kodr).length) delete keys["layout:kodr"];
    fs.writeFileSync(path.join(app, "keys.json"), JSON.stringify(keys, null, 2));
  }
  console.log(`Kodr is out of herdr and Claude's settings. Its state is still in ${home}; delete that folder to remove it too.`);
  process.exit(0);
}

// Where the hooks live: --global puts them in the person's Claude settings, --local takes them out;
// with neither, whatever was chosen last stays (the global file is the record).
const claudeFile = path.join(os.homedir(), ".claude", "settings.json");
const claude = JSON.parse(fs.existsSync(claudeFile) ? fs.readFileSync(claudeFile, "utf8") : "{}");
const wasGlobal = Object.values(claude.hooks ?? {}).some((list) => list.some(isKodr));
const global = process.argv.includes("--global") || (wasGlobal && !process.argv.includes("--local"));
if (global !== wasGlobal || global) {
  const hooks = Object.fromEntries(Object.entries(claude.hooks ?? {}).map(([k, list]) => [k, list.filter((e) => !isKodr(e))]));
  if (global) for (const [k, list] of Object.entries(HOOKS)) hooks[k] = [...(hooks[k] ?? []), ...list];
  for (const k of Object.keys(hooks)) if (!hooks[k].length) delete hooks[k];
  const next = JSON.stringify({ ...claude, hooks }, null, 2);
  if (next !== JSON.stringify(claude, null, 2)) {
    fs.copyFileSync(claudeFile, `${claudeFile}.kodr-backup-${Date.now()}`);
    fs.writeFileSync(claudeFile, next);
    console.log(global ? "Kodr hooks are in ~/.claude/settings.json (backup beside it)" : "Kodr hooks removed from ~/.claude/settings.json");
  }
}

// Claude (Kodr)'s own settings carry the hooks only when the global file doesn't (never both).
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "claude-settings.json"), JSON.stringify(global ? {} : { hooks: HOOKS }, null, 2));
// Bypass is offered in the mode menu (the Shift+Tab cycle) but never the default.
const launch = ["claude", "--settings", path.join(home, "claude-settings.json").replace(/\\/g, "/"), "--allow-dangerously-skip-permissions"];
fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ root, node, herdrApp: herdrApp.replace(/\\/g, "/"), hc: hc.replace(/\\/g, "/"), launch }, null, 2));
for (const mod of MODS) {
  const to = path.join(app, "mods", mod);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(path.join(root, "mod", mod), to, { recursive: true });
}
fs.cpSync(path.join(root, "herdr", "themes", "kodr-zed.json"), path.join(app, "themes", "kodr-zed.json"));
// The kodr layout is Kodr's own (main stays the person's): replaced on every install.
fs.cpSync(path.join(root, "herdr", "layout-kodr.json"), path.join(app, "layouts", "kodr.json"));

// "Claude (Kodr)" in herdr's own new-agent menu: an entry added to the person's programs.json,
// whose other entries are kept as they are.
const programsFile = path.join(app, "programs.json");
let programs = {};
try { programs = JSON.parse(fs.readFileSync(programsFile, "utf8")); } catch {}
programs.programs = { ...(programs.programs ?? {}), "claude-kodr": { name: "Claude (Kodr)", icon: "icons/claude.svg", tint: true, color: "#d97757", run: launch } };
fs.writeFileSync(programsFile, JSON.stringify(programs, null, 2));

// Kodr's keys, only while the kodr layout shows, and only where the person hasn't bound the key there.
const KEYS = JSON.parse(fs.readFileSync(path.join(root, "herdr", "keys.json"), "utf8"))["layout:kodr"]; // the shared layout folder ships the same file
const keysFile = path.join(app, "keys.json");
let keys = null;
try { keys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
if (keys) {
  const section = (keys["layout:kodr"] ??= {});
  const added = Object.entries(KEYS).filter(([k]) => !(k in section) && !(k in (keys.global ?? {})));
  for (const [k, v] of added) section[k] = v;
  if (added.length) fs.writeFileSync(keysFile, JSON.stringify(keys, null, 2));
  for (const [k] of Object.entries(KEYS).filter(([k]) => !added.some(([a]) => a === k) && section[k] !== KEYS[k])) console.log(`key ${k} is already yours; Kodr left it`);
}
console.log(`installed. Start a Kodr session in herdr:\n  herdr-app do tab.new '${JSON.stringify({ name: "claude", argv: launch })}'`);
