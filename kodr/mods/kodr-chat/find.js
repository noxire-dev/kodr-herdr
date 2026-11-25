import { splitBlocks } from "./blocks.js";

// Find in chat (Ctrl+F): which rows hold the query, and the query marked in their markdown. No gpui imports:
// blocks.check.mjs runs it. Marking after Herdr Zoo's claude-chat (markMarkdown).

// The query as typed, any case.
export const findRe = (q, flags = "i") => new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);

// What the find looks through in a row: its text, and for a tool call its line and its output.
export function rowText(r) {
  if (r.kind === "tool") return `${r.summary ?? ""}\n${r.output ?? ""}`;
  return r.kind === "end" ? "" : r.text ?? "";
}

// Every match, oldest first: { i: row, k: its kth mark in that row }. Prose counts the marks markMarkdown makes (code
// blocks aren't marked, so they don't count); a tool call is one hit (its line is marked whole).
export function hits(rows, q) {
  if (!q) return [];
  const re = findRe(q);
  return rows.flatMap((r, i) => {
    if (!re.test(rowText(r))) return [];
    if (r.kind === "tool") return [{ i, k: 0 }];
    const n = splitBlocks(r.text ?? "").reduce((sum, b) => sum + (b.kind === "md" ? countMarks(b.text, q) : 0), 0);
    return Array.from({ length: n }, (_, k) => ({ i, k }));
  });
}

export const countMarks = (md, q) => (markMarkdown(md, q, MARK.hit).match(/<mark /g) ?? []).length;

// TextView draws <mark style="background-color: …"> inside markdown, written just so (a space after the colon,
// no other HTML beside it). Marks go into plain text and link text, around a whole code span, never into a code
// block, a table or a link's address.
export const MARK = { hit: "#f59e0b59", current: "#f59e0bcc" };
// The marks are numbered across a row (start: how many earlier blocks of it had); number cur is drawn brighter.
const wrapper = (color, cur, start) => {
  let n = start;
  return (s) => `<mark style="background-color: ${n++ === cur ? MARK.current : color}">${s}</mark>`;
};
const INLINE = /\\[!-\/:-@[-`{-~]|(`+).+?\1(?!`)|(\*\*|__|\*|~~)(\S(?:.*?\S)?)\2|(!?\[)([^\]]*)(\]\([^)]*\))|<https?:\/\/[^>\s]+>/g;

function inline(s, re, test, wrap) {
  const plain = (x) => x.replace(re, (m) => (m ? wrap(m) : m));
  let out = "", last = 0;
  for (const m of s.matchAll(INLINE)) {
    out += plain(s.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1] !== undefined) out += test.test(m[0]) ? wrap(m[0]) : m[0];
    else if (m[2] !== undefined) out += m[2] + inline(m[3], re, test, wrap) + m[2];
    else if (m[4] !== undefined) out += m[4] + (m[4] === "[" ? inline(m[5], re, test, wrap) : m[5]) + m[6];
    else out += m[0];
  }
  return out + plain(s.slice(last));
}

// Markdown with every hit of q marked, line by line after any list, quote or heading marker.
export function markMarkdown(md, q, color, cur = -1, start = 0) {
  if (!q) return md;
  const wrap = wrapper(color, cur, start);
  const re = findRe(q, "gi"), test = findRe(q);
  let fence = null;
  return md.split("\n").map((l) => {
    const f = /^\s*(`{3,}|~{3,})/.exec(l);
    if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null; return l; }
    if (f) { fence = f[1]; return l; }
    if (/^\s*\|/.test(l) || !test.test(l)) return l;
    const [, head, rest] = /^(\s*(?:>\s*)*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#{1,6}\s+)?)(.*)$/.exec(l);
    return head + inline(rest, re, test, wrap);
  }).join("\n");
}
