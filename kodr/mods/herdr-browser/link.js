// Ctrl/Cmd-clicked localhost links in a terminal open in a Browser pane beside it. Other links pass to the
// next handler (the default browser).
import { run } from "herdr";

export function handleLink({ link, source }) {
  const url = link.url ?? link.raw;
  if (!/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])([:/?#]|$)/i.test(url ?? "")) return "pass";
  run("pane.split", { direction: "right", pane: source.pane, mod: "herdr-browser", props: { url, key: Date.now().toString(36) } });
  return "handled";
}
