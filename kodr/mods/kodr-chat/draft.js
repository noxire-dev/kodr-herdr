// Text the person typed in Claude's terminal and didn't send. hc send waits for it (up to a minute after their last
// key) and then pastes the chat's message after it, so the chat moves it into its own box first. Read from `hc read`:
// the input box is the lines between the last two rules, the first one after "❯".
export function draftOf(screen) {
  const lines = screen.replace(/\r/g, "").split("\n");
  const rules = lines.map((l, i) => (/^─{10,}/.test(l.trim()) ? i : -1)).filter((i) => i >= 0);
  const none = { text: "", lines: 0 };
  if (rules.length < 2) return none;
  const [a, b] = rules.slice(-2), box = lines.slice(a + 1, b);
  if (!box.length || !/^❯/.test(box[0])) return none;
  const width = lines[a].trimEnd().length;
  let text = "";
  box.forEach((l, i) => {
    const s = i === 0 ? l.replace(/^❯[\s ]?/, "") : l.replace(/^ {2}/, "");
    // A line that fills the box wrapped (Claude ate the space at the break); a shorter one ended with a newline.
    text = i === 0 ? s : text + (box[i - 1].trimEnd().length >= width - 3 ? " " : "\n") + s;
  });
  text = text.replace(/[\s ]+$/, "");
  if (!text || /^Try "[^"]*"$/.test(text)) return none; // empty, or Claude's placeholder in a fresh session
  return { text, lines: box.length };
}

// Keys that empty the box from its end: each line's text, then the line break before it (Ctrl+Y in the terminal undoes it).
export const clearKeys = (lines) => ["ctrl+e", "ctrl+u", ...Array.from({ length: Math.max(0, lines - 1) }, () => ["backspace", "ctrl+u"]).flat()];
