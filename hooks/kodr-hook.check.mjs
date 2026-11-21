// node hooks/kodr-hook.check.mjs
// A Claude started inside a Kodr terminal by a tool (claude -p, the SDK) inherits HC_TERMINAL_ID. Its hooks
// must leave the terminal alone, or the chat starts following that run instead of the terminal's Claude.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { terminalDir, roundDue } from "../lib/store.mjs";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "kodr-hook.mjs");
const t = `hookcheck-${process.pid}`, dir = terminalDir(t);
// A yap home with a token (yap installed) and one without, so the crew line is checked both ways on any machine.
const withYap = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-yap-")), noYap = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-noyap-"));
fs.writeFileSync(path.join(withYap, "token"), "x");
const session = (id, entry, yapHome = withYap) => execFileSync(process.execPath, [hook, "session"], {
  input: JSON.stringify({ session_id: id, transcript_path: `/x/${id}.jsonl`, cwd: dir }),
  env: { ...process.env, HC_TERMINAL_ID: t, CLAUDE_CODE_ENTRYPOINT: entry, YAP_HOME: yapHome },
});
try {
  // The terminal's own Claude is told how to add to Mission's todo board; a nested one hears nothing.
  const told = JSON.parse(String(session("real", "cli"))).hookSpecificOutput;
  assert.equal(told.hookEventName, "SessionStart");
  assert.match(told.additionalContext, /kodr-todo\.mjs" add/);
  // …and, with yap installed, when to hand a split goal to yap's crew (the chat shows it as a card).
  assert.match(told.additionalContext, /yap goal "<goal>"[\s\S]*yap go/);
  assert.doesNotMatch(JSON.parse(String(session("real", "cli", noYap))).hookSpecificOutput.additionalContext, /yap goal/);
  fs.rmSync(withYap, { recursive: true, force: true }); fs.rmSync(noYap, { recursive: true, force: true });
  assert.equal(String(session("nested", "sdk-cli")), "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")).session, "real");
  // SessionEnd marks the session ended (the pane stops offering Chat); another session's end doesn't; a new one clears it.
  const hookRun = (event, id) => execFileSync(process.execPath, [hook, event], { input: JSON.stringify({ session_id: id, transcript_path: `/x/${id}.jsonl`, cwd: dir }),
    env: { ...process.env, HC_TERMINAL_ID: t, CLAUDE_CODE_ENTRYPOINT: "cli" } });
  const ended = () => JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8")).ended;
  hookRun("end", "other");
  assert.equal(ended(), undefined);
  hookRun("end", "real");
  assert.equal(typeof ended(), "number");
  hookRun("session", "next");
  assert.equal(ended(), undefined);
  // Review rounds: due only in a linked worktree whose rounds file waits on this terminal.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), "kodr-round-")), gd = path.join(wt, "gd");
  fs.mkdirSync(gd);
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${gd}
`);
  assert.equal(roundDue(wt, "t9"), null); // nothing sent yet
  fs.writeFileSync(path.join(gd, "kodr-rounds.json"), JSON.stringify({ terminal: "t9", n: 12, waiting: true }));
  assert.deepEqual(roundDue(wt, "t9"), { wt, n: 12 });
  assert.equal(roundDue(wt, "t8"), null); // another terminal's turn
  fs.writeFileSync(path.join(gd, "kodr-rounds.json"), JSON.stringify({ terminal: "t9", n: 12, waiting: false }));
  assert.equal(roundDue(wt, "t9"), null); // the round already started
  assert.equal(roundDue(path.dirname(hook), "t9"), null); // not a worktree
  fs.rmSync(wt, { recursive: true, force: true });
  console.log("hook: ok");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
