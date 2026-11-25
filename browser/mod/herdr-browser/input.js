// What the Browser pane sends Chromium: the address bar's text as a URL, and herdr key events as CDP input.

// "3000" and "localhost:3000" are dev servers (http); "example.com" gets https; anything else is a search.
export function toUrl(text) {
  const s = String(text ?? "").trim();
  if (!s) return null;
  if (/^\d{2,5}$/.test(s)) return `http://localhost:${s}`;
  if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(s)) return `http://${s}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|file):/i.test(s)) return s;
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

const SPECIAL = {
  enter: ["Enter", "Enter", 13, "\r"], backspace: ["Backspace", "Backspace", 8], tab: ["Tab", "Tab", 9],
  escape: ["Escape", "Escape", 27], delete: ["Delete", "Delete", 46], home: ["Home", "Home", 36], end: ["End", "End", 35],
  pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
  left: ["ArrowLeft", "ArrowLeft", 37], up: ["ArrowUp", "ArrowUp", 38], right: ["ArrowRight", "ArrowRight", 39], down: ["ArrowDown", "ArrowDown", 40],
};
const EDIT = { a: "selectAll", z: "undo", y: "redo" };

// A herdr KeyEvent → { send: [CDP Input.dispatchKeyEvent params…] } | { copy, cut } | { paste } | null.
// null leaves the key to herdr: Ctrl+Shift chords (herdr's keys, and any a layout adds) and bare modifiers.
export function keyToCdp(e, mac = false) {
  const m = e.modifiers ?? {};
  const primary = mac ? m.platform : m.control;
  if ((m.control || m.platform) && m.shift) return null;
  const key = String(e.key ?? "").toLowerCase();
  if (["shift", "control", "alt", "platform", "cmd", "ctrl"].includes(key)) return null;
  const modifiers = (m.alt ? 1 : 0) | (m.control ? 2 : 0) | (m.platform ? 4 : 0) | (m.shift ? 8 : 0);
  if (primary && key === "c") return { copy: true };
  if (primary && key === "x") return { cut: true };
  if (primary && key === "v") return { paste: true };
  const sp = SPECIAL[key];
  if (sp) {
    const [k, code, vk, text] = sp;
    const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
    return { send: [{ type: text && !modifiers ? "keyDown" : "rawKeyDown", ...base, ...(text && !modifiers ? { text } : {}) }, { type: "keyUp", ...base }] };
  }
  const ch = e.key_char;
  if (ch && !m.control && !m.platform && !m.alt) {
    const upper = ch.toUpperCase();
    const vk = upper.length === 1 && /[A-Z0-9]/.test(upper) ? upper.charCodeAt(0) : 0;
    const base = { key: ch, windowsVirtualKeyCode: vk, modifiers };
    return { send: [{ type: "keyDown", ...base, text: ch, unmodifiedText: ch }, { type: "keyUp", ...base }] };
  }
  if (key.length === 1 && (m.control || m.platform || m.alt)) {
    const vk = key.toUpperCase().charCodeAt(0);
    const base = { key, code: `Key${key.toUpperCase()}`, windowsVirtualKeyCode: vk, modifiers };
    return { send: [{ type: "rawKeyDown", ...base, ...(primary && EDIT[key] ? { commands: [EDIT[key]] } : {}) }, { type: "keyUp", ...base }] };
  }
  return null;
}

// A screencast frame drawn at its own aspect inside the pane: the scale and where pane points land on the page.
export function fit(pane, frame) {
  if (!pane || !frame?.width || !frame?.height) return null;
  const s = Math.min(pane.width / frame.width, pane.height / frame.height);
  return { scale: s, width: frame.width * s, height: frame.height * s };
}

// The pane's tab strip: the pages in its window, kept in the order they first appeared (CDP lists them most recently
// active first, which would reshuffle the strip on every click). Returns the strip and the tab to show.
export function strip(prev, pages) {
  const now = new Map(pages.map((p) => [p.id, p]));
  const tabs = [...prev.filter((t) => now.has(t.id)).map((t) => now.get(t.id)), ...pages.filter((p) => !prev.some((t) => t.id === p.id)).reverse()];
  return { tabs, front: pages[0]?.id ?? null };
}

export function toPage(point, box) {
  if (!point || !box) return null;
  const x = point.x / box.scale, y = point.y / box.scale;
  return { x: Math.round(x), y: Math.round(y) };
}
