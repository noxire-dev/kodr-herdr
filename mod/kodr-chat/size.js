// The chat's text size and font, from the Ctrl+Shift+M menu (shared, so every chat follows): sizes scale every
// text_size in the chat's views; the font replaces herdr's UI font for prose (code keeps the terminal's).
import { shared, settings } from "herdr";

export const SIZES = [["s", "Small", 0.9], ["m", "Medium", 1], ["l", "Large", 1.12]];
// Zed (the default): Zed's own pair, IBM Plex Sans for prose and Lilex for code, shipped in fonts/.
export const FONTS = [["zed", "Zed"], ["default", "Herdr"], ["system", "System"], ["mono", "Mono"]];
export const zoom = () => SIZES.find(([k]) => k === shared("kodr.chat.size"))?.[2] ?? 1;
export const ts = (n) => Math.round(n * zoom() * 2) / 2;
const font = () => shared("kodr.chat.font") ?? "zed";
export function chatFont() {
  const f = font();
  return f === "zed" ? "IBM Plex Sans" : f === "system" ? ".SystemUIFont" : f === "mono" ? codeFont() : null;
}
// Paths, commands, diffs: Lilex with Zed, else the terminal's font.
export const codeFont = () => (font() === "zed" ? "Lilex" : settings().font_family ?? "monospace");
