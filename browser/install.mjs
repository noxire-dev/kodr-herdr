#!/usr/bin/env node
// Installs herdr-browser into herdr-app: the mod, and the herdr-browser MCP server for Claude Code.
//   node install.mjs               install or update (run it again after git pull)
//   node install.mjs --no-mcp      without registering the MCP server with Claude Code
//   node install.mjs --uninstall   take it out again (the browser profile in ~/.herdr-browser stays)
// HERDR_APP_HOME installs into another herdr-app home. Kodr calls install({ mcp: false }): its Claude gets the
// server through its own --mcp-config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url)).replace(/\\/g, "/");
const home = path.join(os.homedir(), ".herdr-browser");
const app = process.env.HERDR_APP_HOME ?? path.join(os.homedir(), ".config", "herdr-app");
const node = process.execPath.replace(/\\/g, "/");
const MOD = "herdr-browser";

function which(cmd) {
  try {
    return execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split(/\r?\n/)[0].trim() || null;
  } catch { return null; }
}
const herdrApp = () => (which("herdr-app") ?? (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "herdr-app", "herdr-app.exe")) ?? "herdr-app").replace(/\\/g, "/");
// The MCP server as Claude Code (or any MCP client) runs it.
export const server = () => ({ command: node, args: [`${root}/browser.mjs`, "--mcp"] });

function claude(args) {
  const bin = which("claude");
  if (!bin) return false;
  // A .cmd shim (npm's install on Windows) only runs through the shell, which joins arguments unquoted: quote them.
  const shim = /\.(cmd|bat)$/i.test(bin);
  try { execFileSync(bin, shim ? args.map((a) => `"${a}"`) : args, { stdio: "ignore", shell: shim }); return true; } catch { return false; }
}

export function install({ mcp = true, quiet = false } = {}) {
  if (!fs.existsSync(app)) throw new Error(`No herdr-app home at ${app}. Start herdr-app once, or set HERDR_APP_HOME.`);
  const to = path.join(app, "mods", MOD);
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(path.join(root, "mod", MOD), to, { recursive: true, filter: (f) => !/\.check\.mjs$|gpui-kit\.d\.ts$|jsconfig\.json$/.test(f) });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ root, node, herdrApp: herdrApp() }, null, 2));
  const log = quiet ? () => {} : console.log;
  if (typeof WebSocket !== "function") log(`Node ${process.versions.node} has no WebSocket: agents get no browser tools. Node 22 or newer has.`);
  else if (mcp) {
    claude(["mcp", "remove", "--scope", "user", "herdr-browser"]);
    const s = server();
    if (claude(["mcp", "add", "--scope", "user", "herdr-browser", "--", s.command, ...s.args])) log("Claude Code has the herdr-browser MCP server (user scope). Restart running sessions to get it.");
    else log(`Claude Code not found. For any MCP client:\n${JSON.stringify({ mcpServers: { "herdr-browser": s } }, null, 2)}`);
  }
  log(`herdr-browser is in ${to}. Open one: Ctrl-click a localhost link (after adding "herdr-browser" to your layout's link_handlers), or\n  herdr-app do pane.split '{"direction":"right","mod":"herdr-browser","props":{"url":"about:blank","key":"x"}}'`);
}

export function uninstall({ mcp = true } = {}) {
  try { execFileSync(node, [path.join(root, "browser.mjs"), "--stop"], { stdio: "ignore", timeout: 5000 }); } catch {}
  fs.rmSync(path.join(app, "mods", MOD), { recursive: true, force: true });
  fs.rmSync(path.join(app, "mods", `${MOD}-frames`), { recursive: true, force: true });
  fs.rmSync(path.join(home, "config.json"), { force: true });
  if (mcp) claude(["mcp", "remove", "--scope", "user", "herdr-browser"]);
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--uninstall")) {
    uninstall();
    console.log(`herdr-browser is out of herdr and Claude Code. Its browser profile is still in ${home}; delete that folder to remove it too.`);
  } else install({ mcp: !process.argv.includes("--no-mcp") });
}
