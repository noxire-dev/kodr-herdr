// A reply's markdown, split at its fenced code blocks so each one can carry a Copy button.
// No gpui imports: blocks.check.mjs runs it under Node.

// → [{ kind: "md", text } | { kind: "code", lang, code, fence }]. A fence still open (Claude is
// mid-reply) runs to the end. Fences indented inside a list item are split out too.
export function splitBlocks(md) {
  const out = [], lines = md.split("\n");
  let prose = [], code = null;
  const flush = () => { const text = prose.join("\n"); if (text.trim()) out.push({ kind: "md", text }); prose = []; };
  for (const line of lines) {
    if (!code) {
      const m = /^(\s*)(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/.exec(line);
      if (m) { flush(); code = { lang: m[3], fence: m[2], indent: m[1].length, body: [] }; }
      else prose.push(line);
      continue;
    }
    const close = line.trim();
    if (close.startsWith(code.fence[0].repeat(code.fence.length)) && /^(`+|~+)$/.test(close)) {
      out.push({ kind: "code", lang: code.lang, code: code.body.join("\n"), fence: code.fence, indent: code.indent });
      code = null;
    } else code.body.push(code.indent && line.startsWith(" ".repeat(code.indent)) ? line.slice(code.indent) : line);
  }
  if (code) out.push({ kind: "code", lang: code.lang, code: code.body.join("\n"), fence: code.fence, indent: code.indent });
  flush();
  return out;
}

// The block again as markdown for TextView (selection). Without its language: TextView draws that
// in the corner the Copy button sits in, so the view shows it beside the button instead.
export const fenced = (b) => `${b.fence}\n${b.code}\n${b.fence}`;
