// Which agents just started needing the person: blocked (a permission or a question), or done while
// they weren't looking. `seen` maps address -> last status and is updated in place. An agent seen for
// the first time is only recorded, so opening Herdr doesn't announce every agent already waiting.
export function attention(seen, agents) {
  const out = [];
  const live = new Set();
  for (const a of agents) {
    live.add(a.address);
    const before = seen.get(a.address);
    seen.set(a.address, a.status);
    if (before === undefined || before === a.status) continue;
    if (a.status === "blocked") out.push({ agent: a, kind: "blocked" });
    else if (a.status === "done" && before === "working") out.push({ agent: a, kind: "done" });
  }
  for (const k of [...seen.keys()]) if (!live.has(k)) seen.delete(k);
  return out;
}

// Notifications per space (the chat's Ctrl+Shift+M menu): "all" (needs you and done), "needs" (only
// blocked: a permission or a question), "off". levels maps space id -> level; a space not in it is "all".
export const LEVELS = [["all", "All"], ["needs", "Needs me"], ["off", "Off"]];
export const levelOf = (levels, space) => (LEVELS.some(([k]) => k === levels?.[space]) ? levels[space] : "all");
export const allowed = (news, levels) => news.filter(({ agent, kind }) => {
  const l = levelOf(levels, agent.space);
  return l === "all" || (l === "needs" && kind === "blocked");
});

// Terminal | Chat is offered while a Claude runs in the pane: herdr sees one (app, live status) and Kodr's
// SessionEnd hook hasn't marked its session ended. Herdr keeps app "claude-code" after Claude exits back to the
// shell, and hc names the shell as foreground even while a Claude typed into it runs, so neither settles it alone.
export const canChat = (p, ended) => (p?.app === "claude-code" || p?.program?.key === "claude") && Boolean(p?.status) && !ended;

// A terminal started from argv is titled with its program's path; that's no name for the header.
export const titleOf = (title) => (title && !/^([a-z]:)?[\\/]|\.exe$/i.test(title.trim()) ? title : null);
