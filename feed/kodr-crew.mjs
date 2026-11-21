#!/usr/bin/env node
// yap's crew as the chat shows it. A Claude in a Kodr chat hands a goal to the crew (`yap goal "…"`, then
// `yap go`); the crew plans tickets, an agent works each one in its own worktree, a fresh reviewer checks it, merges
// pass the gate, and a reporter writes what the crew did. The chat shows that goal as one live card.
//   node feed/kodr-crew.mjs state        {goals, tickets, activity} from the yap daemon, or {down: true}
//   node feed/kodr-crew.mjs --self-check
// Data: the daemon's GET /api/state (127.0.0.1:$YAP_PORT or 4170, token ~/.yap/token), the same JSON yap's board reads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

// The goal a `yap goal` or `yap take` call made, from its output ("goal 12 on issues: a planner is drafting…").
export const goalOf = (command, output) =>
  /\byap (goal|take)\b/.test(command ?? "") ? Number(/^goal (\d+) on /m.exec(output ?? "")?.[1]) || null : null;

// One goal as the card draws it. state: planning | drafts | running | needs | reporting | done | failed | dropped.
export function card(state, id) {
  const goal = state?.goals?.find((g) => g.id === id);
  if (!goal) return null;
  const tickets = (state.tickets ?? []).filter((t) => t.goal_id === id).sort((a, b) => a.id - b.id).map((t) => ({
    id: t.id, title: t.title, status: t.status, round: t.round, note: t.note || null,
    line: ["working", "review", "gate"].includes(t.status) ? state.activity?.[String(t.id)]?.line ?? null : null,
  }));
  const live = tickets.filter((t) => t.status !== "dropped");
  const kind = goal.status === "failed" || goal.status === "dropped" ? goal.status
    : goal.status === "planning" || !tickets.length ? "planning"
    : live.some((t) => t.status === "escalated") ? "needs"
    : live.length && live.every((t) => t.status === "draft") ? "drafts"
    : live.length && live.every((t) => t.status === "merged") ? (goal.summary ? "done" : "reporting")
    : !live.length ? "dropped"
    : "running";
  const merged = live.filter((t) => t.status === "merged").length;
  return { id, text: goal.text, issue: goal.issue ?? null, state: kind, note: goal.note || null, summary: goal.summary || null,
    merged, total: live.length, tickets };
}

export async function crewState() {
  const home = process.env.YAP_HOME ?? path.join(os.homedir(), ".yap");
  let token;
  try { token = fs.readFileSync(path.join(home, "token"), "utf8").trim(); } catch { return { down: true }; }
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.YAP_PORT ?? 4170}/api/state`,
      { headers: { "x-yap-token": token }, signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : { down: true };
  } catch { return { down: true }; }
}

// Fills the chat's crew rows ({kind: "crew", goal}) with their cards: one daemon read for all of them.
export async function attach(rows, read = crewState) {
  const mine = rows.filter((r) => r.kind === "crew");
  if (!mine.length) return rows;
  const state = await read();
  for (const r of mine) r.card = state.down ? { down: true } : card(state, r.goal) ?? { gone: true };
  return rows;
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct && process.argv[2] === "--self-check") {
  assert.equal(goalOf(`yap goal "split the parser"`, "goal 12 on issues: a planner is drafting tickets."), 12);
  assert.equal(goalOf("yap take 7", "goal 3 on issues from #7: a planner is drafting tickets."), 3);
  assert.equal(goalOf("yap status", "goal 12 on issues"), null);
  assert.equal(goalOf(`yap goal x`, "the daemon is not running"), null);
  const g = (status, extra = {}) => ({ id: 1, project_id: 1, text: "Split it", status, note: "", issue: null, summary: "", ...extra });
  const t = (id, status, extra = {}) => ({ id, goal_id: 1, title: `T${id}`, status, round: 1, note: "", ...extra });
  const at = (goal, tickets, activity = {}) => card({ goals: [goal], tickets, activity }, 1);
  assert.equal(card({ goals: [], tickets: [] }, 1), null);
  assert.equal(at(g("planning"), []).state, "planning");
  assert.equal(at(g("ready"), [t(1, "draft"), t(2, "draft")]).state, "drafts");
  const running = at(g("ready"), [t(1, "working", { round: 2 }), t(2, "merged"), t(3, "draft")], { 1: { line: "Edit src/a.ts", at: 5 } });
  assert.deepEqual([running.state, running.merged, running.total, running.tickets[0].line, running.tickets[0].round], ["running", 1, 3, "Edit src/a.ts", 2]);
  assert.equal(running.tickets[1].line, null); // merged: no activity line
  assert.equal(at(g("ready"), [t(1, "escalated", { note: "still failing after 4 rounds" }), t(2, "merged")]).state, "needs");
  assert.equal(at(g("ready"), [t(1, "merged"), t(2, "dropped")]).state, "reporting"); // dropped tickets don't count
  const done = at(g("ready", { summary: "Added a and b." }), [t(1, "merged"), t(2, "merged")]);
  assert.deepEqual([done.state, done.summary, done.merged, done.total], ["done", "Added a and b.", 2, 2]);
  assert.equal(at(g("failed", { note: "planner gave up" }), []).note, "planner gave up");
  assert.equal(at(g("ready"), [t(1, "dropped")]).state, "dropped");
  // attach: one read, down and gone goals said as such
  let reads = 0;
  const rows = [{ kind: "crew", goal: 1 }, { kind: "text" }, { kind: "crew", goal: 9 }];
  await attach(rows, async () => { reads++; return { goals: [g("planning")], tickets: [], activity: {} }; });
  assert.deepEqual([reads, rows[0].card.state, rows[2].card], [1, "planning", { gone: true }]);
  await attach(rows, async () => ({ down: true }));
  assert.deepEqual(rows[0].card, { down: true });
  console.log("kodr-crew: ok");
} else if (direct && process.argv[2] === "state") {
  process.stdout.write(JSON.stringify(await crewState()));
}
