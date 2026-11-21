#!/usr/bin/env node
// Detached from the Stop hook: runs the base commit's checks on one checkpoint, then records them.
import path from "node:path";
import { verify } from "../lib/verify.mjs";
import { terminalDir, readJson, writeJson } from "../lib/store.mjs";

const [t, sha] = process.argv.slice(2);
const dir = terminalDir(t);
const s = readJson(path.join(dir, "session.json"), null);
let r;
try { r = await verify(s.cwd, { base: s.base, sha }); } catch (e) { r = { ok: false, results: [{ name: "verify", ok: false, tail: String(e?.message ?? e) }] }; }
// ponytail: read-modify-write without a lock; a Stop hook landing in the same instant can lose one write.
const file = path.join(dir, "turns.json");
const data = readJson(file, { turns: [] });
const turn = data.turns.find((x) => x.sha === sha);
if (turn) {
  turn.checks = r ? (r.ok ? "pass" : "fail") : null;
  turn.results = r?.results ?? null;
  writeJson(file, data);
}
