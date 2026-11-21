#!/usr/bin/env node
// Kodr's side of the YAP daemon (127.0.0.1:$YAP_PORT or 4170, token in ~/.yap/token), for the chat mod:
//   peers <cwd> <session>                    who else works in this repo, the claims, and this session's own entry
//   say <cwd> <to> <text> [--re id] [--question|--blocker]   a message from the person to a session
//   control <cwd>                            Mission's control pane: agents (doing line, task list), questions and
//                                            blockers waiting on the person, the board's notes, claims
//   unnote <cwd> <id>                        take a note off the board
//   --self-check                             against a fake daemon, and with none
// Prints JSON: { ok, ... } or { down: true } when no daemon answers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTasks } from "../lib/tasks.mjs";
import { transcriptOf } from "../lib/store.mjs";

const url = `http://127.0.0.1:${process.env.YAP_PORT ?? 4170}`;
// The first answer wins; the process then ends on its own. process.exit() right after fetch() trips a libuv assert on
// Windows (UV_HANDLE_CLOSING) once undici has sockets closing.
let said = false;
const out = (v) => { if (!said) process.stdout.write(JSON.stringify(v)); said = true; };
class Stop extends Error {}
const stop = (v) => { out(v); throw new Stop(); };

async function call(verb, body) {
  let token;
  try { token = fs.readFileSync(path.join(process.env.YAP_HOME ?? path.join(os.homedir(), ".yap"), "token"), "utf8").trim(); } catch { stop({ down: true }); }
  let res;
  try {
    res = await fetch(`${url}/yap/${verb}`, { method: "POST", headers: { "content-type": "application/json", "x-yap-token": token }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000) });
  } catch { stop({ down: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) stop({ error: data?.error ?? `yap answered ${res.status}` });
  return data;
}

const [verb, rel, ...rest] = process.argv.slice(2);
// The daemon resolves a relative cwd against its own folder: send it absolute.
const cwd = rel && path.resolve(rel);
if (verb === "--self-check") await selfCheck();
try {
if (!cwd) out({ error: "no cwd" });
else if (verb === "control") {
  const [all, claims, notes] = await Promise.all([call("sessions", { cwd }), call("claims", { cwd }), call("notes", { cwd })]);
  const agents = all.map((p) => {
    const tasks = readTasks(transcriptOf(p.id)).map((x) => ({ text: x.content, status: x.status ?? "pending" }));
    return { id: p.id.slice(0, 8), name: p.name || p.id.slice(0, 8), doing: p.doing ?? "", at: p.at, terminal: p.terminal ?? null,
      files: p.files.length, tasks, done: tasks.filter((x) => x.status === "completed").length };
  });
  // Waiting on the person: what a live session asked @user and nobody has answered (`say --re <id>` answers it).
  const asks = all.flatMap((p) => (p.unanswered ?? []).filter((q) => q.to.includes("the user"))
    .map((q) => ({ id: q.id.slice(0, 8), kind: q.kind, text: q.text, from: p.name || p.id.slice(0, 8) })));
  out({ ok: true, agents, asks,
    notes: notes.map((n) => ({ id: n.id, author: n.author, text: n.text, at: n.ts })),
    claims: claims.map((c) => ({ id: c.id, name: c.name || c.session.slice(0, 8), path: c.path, why: c.why })) });
} else if (verb === "unnote") {
  await call("unnote", { cwd, id: Number(rest[0]) });
  out({ ok: true });
} else if (verb === "peers") {
  const session = rest[0] ?? "";
  const [all, claims] = await Promise.all([call("sessions", { cwd }), call("claims", { cwd })]);
  const self = all.find((p) => session && p.id.startsWith(session)) ?? null;
  const peers = all.filter((p) => p !== self).map((p) => ({
    id: p.id.slice(0, 8), name: p.name || p.id.slice(0, 8), doing: p.doing ?? "", at: p.at, files: p.files.length,
    conflicts: p.conflicts ?? [], unanswered: (p.unanswered ?? []).length,
  }));
  out({ ok: true, peers, claims: claims.map((c) => ({ name: c.name || c.session.slice(0, 8), path: c.path, why: c.why, mine: Boolean(self && c.session === self.id) })),
    self: self && { name: self.name || self.id.slice(0, 8), conflicts: self.conflicts ?? [], unanswered: self.unanswered ?? [] } });
} else if (verb === "say") {
  const [to, ...words] = rest;
  const opts = {};
  const text = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === "--re") opts.re = words[++i];
    else if (words[i] === "--question" || words[i] === "--blocker") opts.kind = words[i].slice(2);
    else text.push(words[i]);
  }
  // The person, typing in Kodr: no session (it would read as the agent), and "via" so peers see "the user, through Kodr".
  const r = await call("say", { cwd, text: text.join(" "), ...(to && to !== "everyone" ? { to: to.replace(/^@/, "") } : {}), ...opts, via: "Kodr" });
  out({ ok: true, to: r.to ?? [], woke: r.woke ?? [] });
} else out({ error: `unknown verb ${verb}` });
} catch (e) { if (!(e instanceof Stop)) throw e; }

async function selfCheck() {
  const assert = (await import("node:assert/strict")).default;
  const http = await import("node:http");
  const { execFileSync } = await import("node:child_process");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-yap-"));
  const run = (env, ...args) => JSON.parse(execFileSync(process.execPath, [process.argv[1], ...args], { env: { ...process.env, YAP_HOME: home, ...env } }).toString());
  // No token, then a token but nothing listening: both are "yap isn't running".
  assert.deepEqual(run({}, "control", "."), { down: true });
  fs.writeFileSync(path.join(home, "token"), "tok");
  const seen = [];
  const answers = {
    sessions: [
      { id: "aaaaaaaa-1", name: "blocks", doing: "review rounds", at: 1, terminal: "t1", files: ["a"],
        unanswered: [{ id: "q1234567890", kind: "question", to: ["the user"], text: "stack or tabs?" }, { id: "q2", kind: "question", to: ["@x"], text: "peer only" }] },
      { id: "bbbbbbbb-2", name: "", at: 2, files: [] },
    ],
    claims: [{ id: "c1", session: "aaaaaaaa-1", name: "blocks", path: "mod/x", why: "w" }],
    notes: [{ id: 7, repo: "r", ts: 5, author: "session @blocks", text: "a note" }],
    unnote: {},
    say: { to: ["blocks"], woke: ["blocks"] },
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const verb = req.url.replace("/yap/", "");
      seen.push([verb, req.headers["x-yap-token"], JSON.parse(body)]);
      if (verb === "unnote" && JSON.parse(body).id === 99) { res.writeHead(500, { connection: "close" }); return res.end(JSON.stringify({ error: "no note #99 on this repo's board" })); }
      // Connection: close, or the child exits with a keep-alive socket open and libuv asserts on Windows.
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify(answers[verb]));
    });
  });
  const free = http.createServer();
  await new Promise((r) => free.listen(0, "127.0.0.1", r));
  const deadPort = free.address().port;
  await new Promise((r) => free.close(r));
  assert.deepEqual(run({ YAP_PORT: String(deadPort) }, "control", "."), { down: true });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const env = { YAP_PORT: String(server.address().port) };
  // execFileSync blocks this process's event loop, so the fake daemon can't answer: run the child async.
  const runAsync = (...args) => new Promise((resolve, reject) => {
    import("node:child_process").then(({ execFile }) => execFile(process.execPath, [process.argv[1], ...args], { env: { ...process.env, YAP_HOME: home, ...env } },
      (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout)))));
  });
  const c = await runAsync("control", "/repo");
  assert.equal(c.ok, true);
  assert.deepEqual(c.agents.map((a) => [a.id, a.name, a.doing, a.terminal, a.tasks.length]), [["aaaaaaaa", "blocks", "review rounds", "t1", 0], ["bbbbbbbb", "bbbbbbbb", "", null, 0]]);
  assert.deepEqual(c.asks, [{ id: "q1234567", kind: "question", text: "stack or tabs?", from: "blocks" }]);
  assert.deepEqual(c.notes, [{ id: 7, author: "session @blocks", text: "a note", at: 5 }]);
  assert.deepEqual(c.claims, [{ id: "c1", name: "blocks", path: "mod/x", why: "w" }]);
  assert.ok(seen.every(([, tok, b]) => tok === "tok" && b.cwd === path.resolve("/repo")));
  assert.deepEqual(await runAsync("unnote", "/repo", "7"), { ok: true });
  assert.deepEqual(seen.at(-1), ["unnote", "tok", { cwd: path.resolve("/repo"), id: 7 }]);
  assert.deepEqual(await runAsync("unnote", "/repo", "99"), { error: "no note #99 on this repo's board" });
  // A Reply typed in Kodr's chat is the person's: no session, and "via": "Kodr", so peers read it as the user through Kodr.
  assert.deepEqual(await runAsync("say", "/repo", "@blocks", "go", "ahead", "--re", "q1234567"), { ok: true, to: ["blocks"], woke: ["blocks"] });
  assert.deepEqual(seen.at(-1), ["say", "tok", { cwd: path.resolve("/repo"), text: "go ahead", to: "blocks", re: "q1234567", via: "Kodr" }]);
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
  console.log("kodr-yap: ok");
  process.exit(0); // no fetch in this process, so exiting here is safe
}
