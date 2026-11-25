#!/usr/bin/env node
// Puts Claude back in terminals that lost it. Herdr's core keeps terminals alive while the app is closed, but a lost
// terminal (core restart or update, reboot, logout) comes back as a shell in its folder and its command is never run
// again. A shell started after its Kodr record was written (so herdr recovered it), whose record (t/<terminal>/session.json) names a session that never ended (SessionEnd marks it)
// and that runs nowhere else was such a Claude: type `claude --resume <id>` (Kodr's launch) into it. Each terminal and
// session is tried once (`resumeTried`), so a resume that fails isn't retried on every start.
// The chat's header mod runs this once when herdr starts. Prints { resumed: [terminal...] }.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { terminalDir, readJson, writeJson } from "../lib/store.mjs";
import { gone, childNames, startedAt } from "./kodr-alive.mjs";


// terms: [{ address, shell, since }] (shell: no Claude runs in it; since: when the shell started); records: { address: { session, ended?, resumeTried?, mtime } }.
// → the terminals to resume, with their session.
export function pick(terms, records) {
  // The newest record of a session is the one that counts (an older terminal may hold a stale copy).
  const newest = new Map();
  for (const [t, r] of Object.entries(records)) if (r?.session && !(newest.get(r.session)?.mtime >= r.mtime)) newest.set(r.session, { t, ...r });
  const running = new Set(terms.filter((x) => !x.shell).map((x) => records[x.address]?.session).filter(Boolean));
  return terms.filter((x) => {
    const r = records[x.address];
    // The shell started after its Claude last wrote the record: herdr recovered it. A shell you typed claude into
    // started before; that Claude was killed or crashed under you, and stays down (its pane drops Chat).
    return x.shell && x.since > r?.mtime && r?.session && !r.ended && r.resumeTried !== r.session && !running.has(r.session) && newest.get(r.session)?.t === x.address;
  }).map((x) => ({ terminal: x.address, session: records[x.address].session }));
}

const arg = (a) => (/[\s"']/.test(a) ? `"${a}"` : a);

function main(dry) {
  const config = readJson(path.join(os.homedir(), ".kodr-herdr", "config.json"), {});
  const hcBin = config.hc || "hc";
  const env = { ...process.env };
  delete env.HC_TERMINAL_ID; // with it set, hc send wraps the text in <hc from=…>, which a shell can't run
  const hc = (args) => execFileSync(hcBin, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "ignore"] });
  const live = JSON.parse(hc(["ls", "--json"])).terminals.filter((x) => x.state === "live");
  const terms = live.map((x) => {
    let shell = false, since = null;
    try { const info = JSON.parse(hc(["get", x.address])); shell = gone(info, childNames); if (shell) since = startedAt(info.pid); } catch {}
    return { address: x.address, shell, since };
  });
  const records = {};
  for (const x of live) {
    const f = path.join(terminalDir(x.address), "session.json");
    try { records[x.address] = { ...JSON.parse(fs.readFileSync(f, "utf8")), mtime: fs.statSync(f).mtimeMs }; } catch {}
  }
  const launch = config.launch ?? ["claude"];
  const resumed = [];
  if (dry) return process.stdout.write(JSON.stringify({ would: pick(terms, records), terms }));
  for (const { terminal, session } of pick(terms, records)) {
    const f = path.join(terminalDir(terminal), "session.json");
    writeJson(f, { ...readJson(f, {}), resumeTried: session });
    try { hc(["send", terminal, [...launch, "--resume", session].map(arg).join(" ")]); resumed.push(terminal); } catch {}
  }
  process.stdout.write(JSON.stringify({ resumed }));
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url); // not when imported
if (isMain && process.argv[2] === "--self-check") {
  const { strict: assert } = await import("node:assert");
  const terms = [
    { address: "a", shell: true, since: 10 }, // lost Claude: resume
    { address: "b", shell: true, since: 10 }, // ended normally
    { address: "c", shell: true, since: 10 }, // stale copy of d's session, d runs it
    { address: "d", shell: false },
    { address: "e", shell: true, since: 10 }, // tried already
    { address: "f", shell: true, since: 10 }, // stale copy of a's session (older)
    { address: "g", shell: false }, // a Claude, not a shell
  ];
  const records = {
    a: { session: "s1", mtime: 5 }, b: { session: "s2", ended: 1, mtime: 5 }, c: { session: "s3", mtime: 1 },
    d: { session: "s3", mtime: 9 }, e: { session: "s4", resumeTried: "s4", mtime: 5 }, f: { session: "s1", mtime: 1 },
    g: { session: "s5", mtime: 5 },
  };
  assert.deepEqual(pick(terms, records), [{ terminal: "a", session: "s1" }]);
  // A Claude killed inside a shell started before it: not resumed.
  assert.equal(pick([{ address: "a", shell: true, since: 1 }], { a: { session: "s1", mtime: 5 } }).length, 0);
  // A Claude that ended in a terminal later resumed by Kodr: tried flag is per session, so a new one counts again.
  assert.equal(pick([{ address: "e", shell: true, since: 10 }], { e: { session: "s6", resumeTried: "s4", mtime: 1 } }).length, 1);
  console.log("kodr-resume: ok");
} else if (isMain) main(process.argv[2] === "--dry");
