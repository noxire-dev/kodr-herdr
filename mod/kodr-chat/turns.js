// The chat's rows as turns, the way the terminal folds them: your message, then one line for all the work
// ("Worked for 1m 32s · 6 tool calls · 2 edits"), then the answer. No gpui imports: turns.check.mjs runs it.
//
// → [{ kind: "user", row, i } | { kind: "turn", at, work: [row & {_i}], answer, end, asks, stats, files } | { kind: "aside", row, i }]
// answer: the turn's last text when nothing but its end follows it (while Claude still works it's narration, in work).
// asks: work rows waiting on the person (permission, question, plan): shown outside the fold.
// aside: yap messages and notes, which are for the person, kept in the order they came.
export function turns(rows) {
  const out = [];
  let turn = null;
  const open = (at) => { turn = { kind: "turn", at, work: [], answer: null, end: null }; out.push(turn); return turn; };
  rows.forEach((r, i) => {
    if (r.kind === "user") { out.push({ kind: "user", row: r, i }); turn = null; return; }
    if (r.kind === "yap" || r.kind === "note" || r.kind === "crew") { out.push({ kind: "aside", row: r, i }); return; }
    const t = turn ?? open(i);
    if (r.kind === "end") { t.end = { ...r, _i: i }; turn = null; return; }
    t.work.push({ ...r, _i: i });
  });
  for (const t of out) {
    if (t.kind !== "turn") continue;
    const last = t.work.at(-1);
    if (last?.kind === "text" && t.end) t.answer = t.work.pop();
    t.asks = t.work.filter((r) => r.ask?.state === "pending");
    t.stats = stats(t.work);
    t.files = files(t.work);
  }
  return out.filter((t) => t.kind !== "turn" || t.work.length || t.answer || t.end);
}

function stats(work) {
  const tools = work.filter((r) => r.kind === "tool");
  return {
    tools: tools.length,
    edits: tools.filter((r) => r.diff).length,
    failed: tools.filter((r) => r.state === "error" && !r.ask?.declined).length,
    thoughts: work.filter((r) => r.kind === "thinking").length,
  };
}

// Files the turn changed, from its edits' diffs: [{ file, add, del }], biggest change first.
function files(work) {
  const by = new Map();
  for (const r of work) {
    if (r.kind !== "tool" || !r.diff || r.state === "error") continue;
    const f = by.get(r.summary) ?? { file: r.summary, add: 0, del: 0 };
    for (const l of r.diff) { if (l.startsWith("+")) f.add++; else if (l.startsWith("-")) f.del++; }
    by.set(r.summary, f);
  }
  return [...by.values()].sort((a, b) => b.add + b.del - (a.add + a.del));
}

// "Worked for 1m 32s · 6 tool calls · 2 edits" (or "Working for …" while it runs; ms from its end row).
export function summary(t, ms, working) {
  const s = Math.round((ms ?? 0) / 1000);
  const time = s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
  const { tools, edits } = t.stats;
  const bits = [ms != null ? `${working ? "Working" : "Worked"} for ${time}` : working ? "Working" : "Worked",
    tools ? `${tools} tool call${tools === 1 ? "" : "s"}` : null, edits ? `${edits} edit${edits === 1 ? "" : "s"}` : null];
  return bits.filter(Boolean).join(" · ");
}
