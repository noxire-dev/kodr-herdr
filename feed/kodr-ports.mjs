// Dev servers running in herdr's terminals, for the Preview mod (mod/kodr-preview).
//   node feed/kodr-ports.mjs              → { servers: [{ port, url, title, terminal, space, where, command }], deft }
//                                           deft: Deft (browser extension the agent drives) is installed; without it Preview uses the browser
//   node feed/kodr-ports.mjs --open URL   → opens URL in Deft (a new tab in the browser with Deft), { ok } or { error }
//   node feed/kodr-ports.mjs --self-check
// A server is a TCP port listening on this computer whose process descends from a live terminal's process
// (an agent's background `npm run dev` included), and that answers HTTP.
import { execFile } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const run = async (cmd, args) => (await promisify(execFile)(cmd, args, { maxBuffer: 32 << 20, windowsHide: true })).stdout;
const WIN = process.platform === "win32";

// Listening sockets → [{ port, pid }]. netstat (Windows) and lsof (macOS) answer in well under a second.
export function parseListen(text, win = WIN) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (win) {
      const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
      if (m) out.push({ host: m[1], port: +m[2], pid: +m[3] });
    } else {
      // lsof -F pn: "p<pid>" then "n<host>:<port>" lines for that pid.
      if (line[0] === "p") out.pid = +line.slice(1);
      else if (line[0] === "n") {
        const m = /^n(.*):(\d+)$/.exec(line);
        if (m) out.push({ host: m[1], port: +m[2], pid: out.pid });
      }
    }
  }
  // Loopback or all interfaces only; one entry per port.
  const local = out.filter((s) => /^(127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|::1?|\*|localhost)$/.test(s.host));
  return [...new Map(local.map((s) => [s.port, { port: s.port, pid: s.pid }])).values()];
}

// "pid ppid [name]" lines for the whole machine → pid → parent pid, and pid → process name.
export function parseParents(text) {
  const parents = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)(?:\s.*)?$/.exec(line);
    if (m) parents.set(+m[1], +m[2]);
  }
  return parents;
}
export function parseNames(text) {
  const names = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+\d+\s+(.+?)\s*$/.exec(line);
    if (m) names.set(+m[1], m[2]);
  }
  return names;
}

// A port a browser (the debugging port of a headless Chrome an agent drives, say) or Claude Code itself listens on
// answers HTTP but isn't a dev server. A server Claude starts runs as node, python and so on, and still counts.
export const notServer = (name) => /^(chrome|chromium|msedge|firefox|zen|brave|opera|google chrome( helper)?|claude)(\.exe)?$/i.test(name ?? "");
// What a row says runs there: the terminal's title, unless that's only a program's path (a terminal started from
// argv is titled with it); then the listening process's name.
export const commandOf = (title, name) => (title && !/^([a-z]:)?[\\/]|\.exe$/i.test(title.trim()) ? title : name ?? null);

// The terminal whose process is pid or one of its ancestors, or null.
export function ownerOf(pid, parents, roots) {
  for (let p = pid, n = 0; p && n < 64; p = parents.get(p), n++) if (roots.has(p)) return roots.get(p);
  return null;
}

const listen = async () => parseListen(WIN ? await run("netstat", ["-ano", "-p", "tcp"]) + await run("netstat", ["-ano", "-p", "tcpv6"])
  : await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]).catch((e) => e.stdout ?? ""));
const procs = async () => WIN
  ? await run("powershell.exe", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | % { \"$($_.ProcessId) $($_.ParentProcessId) $($_.Name)\" }"])
  : await run("ps", ["-axo", "pid=,ppid=,comm="]);

// The page's <title>, or null when the port doesn't speak HTTP.
async function probe(port) {
  try {
    const r = await fetch(`http://localhost:${port}/`, { signal: AbortSignal.timeout(1500), redirect: "follow" });
    const body = (r.headers.get("content-type") ?? "").includes("html") ? await r.text() : "";
    return { title: /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim() || null };
  } catch { return null; }
}

async function servers() {
  const ls = JSON.parse(await run("hc", ["ls", "--json"]));
  const live = (ls.terminals ?? []).filter((t) => t.state === "live");
  const roots = new Map();
  await Promise.all(live.map(async (t) => {
    const g = JSON.parse(await run("hc", ["get", t.address, "--json"]).catch(() => "{}"));
    if (g.pid) roots.set(g.pid, { terminal: t.address, space: g.labels?.["herdr.space"] ?? null, where: t.where ?? null, command: g.title ?? null });
  }));
  const [socks, ps] = await Promise.all([listen(), procs()]);
  const tree = parseParents(ps), names = parseNames(ps);
  const nameOf = (pid) => names.get(pid)?.split("/").pop(); // macOS ps gives a path
  const found = socks.filter((s) => !notServer(nameOf(s.pid))).map((s) => {
    const o = ownerOf(s.pid, tree, roots);
    return o && { ...s, owner: { ...o, command: commandOf(o.command, nameOf(s.pid)) } };
  }).filter(Boolean);
  const probed = await Promise.all(found.map(async (s) => ({ s, http: await probe(s.port) })));
  return probed.filter((x) => x.http).map(({ s, http }) => ({ port: s.port, url: `http://localhost:${s.port}/`, title: http.title, ...s.owner }))
    .sort((a, b) => a.port - b.port);
}

const deftDir = () => (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "zen-agent") : null);
const hasDeft = () => Boolean(deftDir()) && existsSync(join(deftDir(), "token"));

// Deft's host serves its tools over HTTP on 47823 (Zen/Firefox) or 47824 (Chrome) while that browser is open.
async function openInDeft(url) {
  const dir = deftDir();
  let token;
  try { token = readFileSync(join(dir ?? ".", "token"), "utf8").trim(); } catch { return { error: "Deft isn't installed" }; }
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "navigate", arguments: { url, new_tab: true } } });
  for (const port of [47823, 47824]) {
    let r;
    try {
      r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body, signal: AbortSignal.timeout(20_000),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` } });
    } catch { continue; }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.result || j.result.isError) return { error: j?.result?.content?.[0]?.text ?? `Deft refused (HTTP ${r.status})` };
    return { ok: true };
  }
  return { error: "No browser with Deft is open" };
}

function selfCheck() {
  const assert = (c, m) => { if (!c) throw new Error(m); };
  const win = parseListen([
    "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       2352",
    "  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       43260",
    "  TCP    192.168.1.5:139        0.0.0.0:0              LISTENING       4",
    "  TCP    [::1]:5173             [::]:0                 LISTENING       43260",
    "  TCP    127.0.0.1:5173         127.0.0.1:50000        ESTABLISHED     43260",
  ].join("\r\n"), true);
  assert(JSON.stringify(win) === JSON.stringify([{ port: 135, pid: 2352 }, { port: 5173, pid: 43260 }]), `windows listen: ${JSON.stringify(win)}`);
  const mac = parseListen("p501\nn127.0.0.1:3000\nn[::1]:3000\np777\nn*:8080\np9\nn10.0.0.2:22\n", false);
  assert(JSON.stringify(mac) === JSON.stringify([{ port: 3000, pid: 501 }, { port: 8080, pid: 777 }]), `mac listen: ${JSON.stringify(mac)}`);
  const tree = parseParents("  1 0\n 10 1\n 20 10\n 30 20\n 40 1\n 50 50\n");
  const roots = new Map([[10, "t1"]]);
  assert(ownerOf(30, tree, roots) === "t1", "grandchild belongs to the terminal");
  assert(ownerOf(10, tree, roots) === "t1", "the terminal's own process");
  assert(ownerOf(40, tree, roots) === null, "a sibling outside the terminal");
  assert(ownerOf(50, tree, roots) === null, "a pid that is its own parent ends");
  // Names ride along: "pid ppid name". A browser's debugging port or Claude's own isn't a dev server; node is,
  // even when Claude started it.
  const names = parseNames(" 30940 12 chrome.exe\n 42200 7 node.exe\n 9 1 claude\n 5 1 Google Chrome Helper\n");
  assert(names.get(30940) === "chrome.exe" && names.get(5) === "Google Chrome Helper", `names: ${[...names]}`);
  assert(parseParents(" 30940 12 chrome.exe\n").get(30940) === 12, "parents still parse with a name column");
  assert(notServer("chrome.exe") && notServer("msedge.exe") && notServer("firefox") && notServer("Google Chrome Helper") && notServer("claude.exe") && notServer("claude"), "browsers and Claude");
  assert(!notServer("node.exe") && !notServer("python3") && !notServer("bun") && !notServer(undefined), "servers");
  // The command shown: the terminal's title, unless it's only a program's path; then the listening process's name.
  assert(commandOf("npm run dev", "node.exe") === "npm run dev", "a title that says what runs");
  assert(commandOf("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "node.exe") === "node.exe", "a shell's path");
  assert(commandOf("/bin/zsh", "node") === "node", "a unix path");
  assert(commandOf(null, "node.exe") === "node.exe" && commandOf(null, undefined) === null, "no title");
  console.log("kodr-ports self-check ok");
}

const [flag, arg] = process.argv.slice(2);
if (flag === "--self-check") selfCheck();
else {
  const out = await (flag === "--open" ? (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(arg ?? "") ? openInDeft(arg) : { error: "not a local URL" })
    : servers().then((s) => ({ servers: s, deft: hasDeft() })).catch((e) => ({ error: String(e?.message ?? e) })));
  process.stdout.write(JSON.stringify(out));
}
