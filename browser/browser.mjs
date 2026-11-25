#!/usr/bin/env node
// Starts (or finds) the headless Chromium the Browser pane draws: one per machine, on a fixed CDP port, its
// own profile in ~/.herdr-browser/profile so your real browser is never touched. The mod execs this, reads
// {ok, port, browser} and talks CDP itself. Agents attach to the same port (Playwright connectOverCDP).
//   node browser.mjs           start or reuse, print JSON
//   node browser.mjs --stop    close it
//   node browser.mjs --mcp     the herdr-browser MCP server for agents (tools.mjs)
//   node browser.mjs --self-check
// HERDR_BROWSER picks the executable, HERDR_BROWSER_PORT the port (default 9333).
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PORT = Number(process.env.HERDR_BROWSER_PORT) || 9333;

export function candidates(platform = process.platform, env = process.env) {
  if (env.HERDR_BROWSER) return [env.HERDR_BROWSER];
  if (platform === "win32") {
    const pf = [env["ProgramFiles(x86)"], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
    return pf.flatMap((d) => [join(d, "Microsoft/Edge/Application/msedge.exe"), join(d, "Google/Chrome/Application/chrome.exe")]);
  }
  if (platform === "darwin") {
    return ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser"].map((n) => `/Applications/${n}.app/Contents/MacOS/${n}`);
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

export function args(port, profile) {
  return ["--headless=new", `--remote-debugging-port=${port}`, "--remote-allow-origins=*", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "--mute-audio", "--disable-extensions", "--disable-sync", "about:blank"];
}

async function version(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

async function start() {
  const running = await version(PORT);
  if (running) return { ok: true, port: PORT, browser: running.Browser };
  const exe = candidates().find((p) => existsSync(p));
  if (!exe) return { error: "No Edge or Chrome found. Install one, or set HERDR_BROWSER to a Chromium executable." };
  const child = spawn(exe, args(PORT, join(homedir(), ".herdr-browser", "profile")), { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  for (let i = 0; i < 50; i++) {
    const v = await version(PORT);
    if (v) {
      // Chromium opens a blank tab no pane shows; close it, so every page belongs to a Browser pane (the browser
      // keeps running with none).
      for (const t of await pages()) await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`).catch(() => {});
      return { ok: true, port: PORT, browser: v.Browser };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { error: `${exe} didn't open CDP on port ${PORT} within 10 s. Is something else on that port?` };
}

async function pages() {
  try { return (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === "page"); } catch { return []; }
}

// `--mcp`: the herdr-browser MCP server (stdio, a JSON-RPC message per line) agents get; the tools are in
// tools.mjs. Before each tool call it makes sure the browser runs and that a Browser pane shows it:
// with no pages open it splits one off the focused pane (ponytail: herdr's CLI can't name the agent's own pane),
// so an agent's first browser call opens the pane beside it.
async function mcp() {
  const { CdpBrowser, connectCdp, handle, pageJs } = await import("./tools.mjs");
  const browser = new CdpBrowser(() => connectCdp(`http://127.0.0.1:${PORT}`), pageJs());
  const { createInterface } = await import("node:readline");
  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    // Calls run one after another, in order: a tool call can open the pane that the next one needs.
    const res = await handle(req, browser, ensurePane);
    if (res) process.stdout.write(JSON.stringify(res) + "\n");
  }
  process.exit(0); // the client went away; the open CDP socket would keep us running
}

async function ensurePane() {
  const started = await start();
  if (!started.ok) throw new Error(started.error);
  if ((await pages()).length) return;
  const config = JSON.parse(readFileSync(join(homedir(), ".herdr-browser", "config.json"), "utf8"));
  const split = { direction: "right", mod: "herdr-browser", props: { url: "about:blank", key: Date.now().toString(36) } };
  spawn(config.herdrApp, ["do", "pane.split", JSON.stringify(split)], { stdio: "ignore", windowsHide: true });
  for (let i = 0; i < 50 && !(await pages()).length; i++) await new Promise((r) => setTimeout(r, 200));
}

async function stop() {
  const v = await version(PORT);
  if (!v) return { ok: true };
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
  await new Promise((r) => setTimeout(r, 300));
  return { ok: true };
}

function selfCheck() {
  const assert = (c, m) => { if (!c) { console.error("FAIL", m); process.exit(1); } };
  const w = candidates("win32", { ProgramFiles: "C:\\PF", "ProgramFiles(x86)": "C:\\PF86" });
  assert(w[0].endsWith("msedge.exe") && w[0].startsWith("C:\\PF86"), "windows prefers Edge in Program Files (x86)");
  assert(candidates("darwin", {})[0] === "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "mac app bundle path");
  assert(candidates("win32", { HERDR_BROWSER: "x" })[0] === "x", "HERDR_BROWSER wins");
  const a = args(9333, "/p");
  assert(a.includes("--remote-debugging-port=9333") && a.includes("--user-data-dir=/p") && a[0] === "--headless=new", "args");
  console.log("herdr-browser self-check ok");
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/").replace(/^\//, "")}`) {
  const cmd = process.argv[2];
  if (cmd === "--self-check") selfCheck();
  else if (cmd === "--mcp") await mcp();
  else console.log(JSON.stringify(await (cmd === "--stop" ? stop() : start())));
}
