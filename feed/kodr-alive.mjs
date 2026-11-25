#!/usr/bin/env node
// Is a Claude still running in this terminal? Herdr keeps a pane's app "claude-code" (and its last status) after
// Claude dies inside a shell, and a killed or crashed Claude never runs Kodr's SessionEnd hook, so neither says it's
// gone. The process tree does: gone = the shell is back in front (hc's foreground is the terminal's own shell) and no
// claude/node process runs under it. Prints { gone }. Used by the pane header (Terminal | Chat) and kodr-resume.
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJson } from "../lib/store.mjs";

export const SHELL = /^(pwsh|powershell|cmd|bash|zsh|fish|sh|nu)(\.exe)?$/i;
const CLAUDE = /^(claude|node)(\.exe)?$/i;

// info: hc get's JSON. children(pid) → process names under pid (direct children).
export function gone(info, children) {
  const fg = info?.foreground;
  if (!fg || info.state !== "live") return false;
  if (fg.pid !== info.pid || !SHELL.test(fg.name ?? "")) return false; // something runs in front of the shell
  return !children(info.pid).some((n) => CLAUDE.test(n));
}

export function childNames(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${Number(pid)}' | ForEach-Object { $_.Name }`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
      return out.split(/\r?\n/).filter(Boolean);
    }
    // macOS and Linux: every process with its parent (ps -A works on both).
    return execFileSync("ps", ["-A", "-o", "ppid=,comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n")
      .map((l) => l.trim().split(/\s+/)).filter(([pp]) => Number(pp) === Number(pid)).map(([, ...c]) => path.basename(c.join(" ")));
  } catch { return ["?"]; } // unknown: not gone
}

// When a process started (ms), or null.
export function startedAt(pid) {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString("o")`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
      return Date.parse(out.trim()) || null;
    }
    const out = execFileSync("ps", ["-o", "lstart=", "-p", String(Number(pid))], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Date.parse(out.trim()) || null;
  } catch { return null; }
}

export function hcGet(terminal) {
  const config = readJson(path.join(os.homedir(), ".kodr-herdr", "config.json"), {});
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID;
  return JSON.parse(execFileSync(config.hc || "hc", ["get", terminal], { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] }));
}

const main = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url); // not when imported
if (main && process.argv[2] === "--self-check") {
  const { strict: assert } = await import("node:assert");
  const shell = { state: "live", pid: 1, foreground: { pid: 1, name: "pwsh.exe" } };
  assert.equal(gone(shell, () => []), true); // Claude died, shell in front
  assert.equal(gone(shell, () => ["claude.exe"]), false); // hc shows the shell, but a Claude runs under it
  assert.equal(gone({ ...shell, foreground: { pid: 7, name: "claude.exe" } }, () => []), false); // Claude in front
  assert.equal(gone({ state: "live", pid: 1, foreground: { pid: 1, name: "claude.exe" } }, () => []), false); // started as Claude
  assert.equal(gone({ ...shell, state: "finished" }, () => []), false);
  console.log("kodr-alive: ok");
} else if (main && process.argv[2]) {
  let out = { gone: false };
  try { out = { gone: gone(hcGet(process.argv[2]), childNames) }; } catch {}
  process.stdout.write(JSON.stringify(out));
}
