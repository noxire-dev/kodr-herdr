// Mission control's pure parts: which folder a space is really in, and the board as filtered lanes.

// Where a space's work is: the live folder of the first pane in its tabs that has one (what Herdr names
// the space after), else the folder it was made with. A space opened at home and cd'd into a repo keeps
// `folder` = home; a terminal's own cwd is where it started, so neither will do.
export function folderOf(space, panes) {
  if (!space) return null;
  const tabs = new Set((space.tabs ?? []).map((x) => x.id));
  return panes.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder || null;
}

export const LANES = [
  { key: "todo", title: "Todo", color: "dim" },
  { key: "ongoing", title: "Ongoing", color: "working" },
  { key: "in-review", title: "In review", color: "accent" },
  { key: "blocked", title: "Blocked", color: "blocked" },
];
export const EXTRA = [{ key: "future", title: "Future", color: "dim" }, { key: "done", title: "Done", color: "done" }];

// filter: "all" | "cycle" | "waiting" | "mine"; query matches "#N", a number or title text; extra adds
// Future and Done. In a lane, waiting cards come first, then the cycle in its order, then board order.
export function lanes(board, { filter = "all", query = "", extra = false, viewer = board.viewer } = {}) {
  const cycle = board.cycle?.open ?? [];
  const tests = {
    all: () => true,
    cycle: (c) => cycle.includes(c.number),
    waiting: (c) => c.waiting && c.column !== "done",
    mine: (c) => Boolean(viewer) && (c.assignees ?? []).includes(viewer),
  };
  const q = query.trim().toLowerCase().replace(/^#/, "");
  const hit = (c) => !q || String(c.number) === q || c.title.toLowerCase().includes(q);
  const open = (c) => c.column !== "done";
  const all = Object.values(board.columns ?? {}).flat();
  const counts = Object.fromEntries(Object.entries(tests).map(([k, f]) => [k, all.filter((c) => open(c) && f(c)).length]));
  const rank = (c) => (c.waiting ? 0 : 1) * 1000 + (cycle.includes(c.number) ? cycle.indexOf(c.number) : 999);
  const shown = [...LANES, ...(extra ? EXTRA : [])].map((l) => ({
    ...l,
    cards: (board.columns?.[l.key] ?? []).filter((c) => tests[filter](c) && hit(c))
      .map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c),
  }));
  return { lanes: shown, counts, total: all.length };
}

// Where a card's branch is on its way to merging. review: no clean review of the checked-out commit yet
// (or it had uncommitted changes); open: push and open a PR; push: the PR is behind that commit;
// merge: the PR holds exactly the reviewed commit; merged. empty: no commits beyond the default branch.
export function mergeStep(review, pr, head) {
  if (pr?.merged) return "merged";
  const clean = review?.state === "done" && !review.fix && review.head === head && !review.dirty;
  if (!clean) return "review";
  if (review.empty) return "empty";
  if (!pr) return "open";
  return pr.head === head ? "merge" : "push";
}
