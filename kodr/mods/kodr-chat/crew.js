// A goal this chat's Claude handed to yap's crew (`yap goal`): one live card with its tickets, what needs you, and
// when it's done, the reporter's account of what the crew did. Drawing only; feed/kodr-crew.mjs fills r.card.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { icon, chip } from "./cards.js";
import { ts, codeFont } from "./size.js";

const STATE = {
  planning: ["Planning", "muted"], drafts: ["Drafts ready", "foreground"], running: ["Running", "working"],
  needs: ["Needs you", "blocked"], reporting: ["Writing the report", "working"], done: ["Done", "done"],
  failed: ["Failed", "blocked"], dropped: ["Dropped", "dim"],
};
const TICKET = { draft: "draft", todo: "queued", working: "working", review: "in review", gate: "at the gate", merged: "merged",
  escalated: "needs you", dropped: "dropped" };
const COLOR = { working: "working", review: "working", gate: "working", merged: "done", escalated: "blocked", draft: "muted", todo: "muted" };

export function crewRow(r, i, t) {
  const c = r.card;
  const box = v_flex().id(`cr${i}`).my(8).rounded(8).border_1().bg(t.chrome).overflow_hidden();
  const line = (text, color = t.dim) => div().px(12).pb(10).text_size(ts(13)).text_color(color).child(text);
  const head = (label, label2, color) => h_flex().px(12).pt(9).pb(6).gap(8).items_center()
    .child(svg(icon("agent")).size(14).flex_none().text_color(color))
    .child(div().flex_none().text_size(ts(13.5)).font_medium().text_color(t.foreground).child("Crew"))
    .child(div().flex_1().min_w(0).truncate().text_size(ts(13)).text_color(t.dim).child(label))
    .when(Boolean(label2), (el) => el.child(chip(label2, color)));
  if (!c || c.down) return box.border_color(t.border).child(head(`goal #${r.goal}`, null, t.dim))
    .child(line(c ? "yap isn't running, so the crew's progress can't be read. Start it: yap start" : "Reading the crew…"));
  if (c.gone) return box.border_color(t.border).child(head(`goal #${r.goal}`, null, t.dim)).child(line("This goal is no longer on yap's board."));
  const [label, key] = STATE[c.state] ?? ["", "dim"];
  const color = t[key] ?? t.dim;
  const live = c.state === "planning" || c.state === "running" || c.state === "reporting";
  const tickets = c.tickets.map((x) => {
    const tc = t[COLOR[x.status]] ?? t.dim;
    const status = x.status === "working" && x.round > 1 ? `working · round ${x.round}` : TICKET[x.status] ?? x.status;
    return v_flex().id(`ct${i}-${x.id}`).px(12).py(4).gap(2)
      .child(h_flex().gap(8).items_center()
        .child(x.status === "merged" ? svg(icon("check")).size(12).flex_none().text_color(tc)
          : div().size(8).mx(2).flex_none().rounded(4).when(x.status === "working" || x.status === "escalated", (el) => el.bg(tc))
            .when(x.status !== "working" && x.status !== "escalated", (el) => el.border_1().border_color(tc))
            .when(["working", "review", "gate"].includes(x.status), (el) => el.loop("opacity", { from: 0.3, to: 1, period: 1200 })))
        .child(div().w(26).flex_none().font_family(codeFont()).text_size(ts(12)).text_color(t.dim).child(`t${x.id}`))
        .child(div().flex_1().min_w(0).truncate().text_size(ts(13.5)).text_color(x.status === "dropped" ? t.dim : t.foreground).child(x.title))
        .child(div().flex_none().text_size(ts(12.5)).text_color(tc).child(status)))
      .when(Boolean(x.line), (el) => el.child(div().pl(41).truncate().font_family(codeFont()).text_size(ts(12)).text_color(t.dim).child(x.line)))
      .when(x.status === "escalated" && Boolean(x.note), (el) => el.child(div().pl(41).text_size(ts(13)).text_color(t.blocked).child(x.note)));
  });
  const foot = {
    planning: "A planner is reading the repo and drafting tickets with acceptance criteria.",
    drafts: "The drafts wait for a go: run `yap go`, or ask Claude to. Edit them first on yap's board (`yap`).",
    running: "Each ticket has its own agent and worktree; a fresh reviewer checks it before it merges.",
    needs: "A ticket ran out of review rounds. Retry it with a note, approve it or drop it on yap's board (`yap`).",
    reporting: "Everything merged. The reporter is writing what the crew did.",
    failed: c.note ?? "The planner couldn't make tickets from this goal.",
    dropped: "The goal was dropped before it finished.",
  }[c.state];
  return box.border_color(c.state === "needs" ? t.blocked : t.border)
    .child(head(`goal #${c.id}${c.total ? ` · ${c.merged}/${c.total} merged` : ""}`, label, color))
    .child(div().px(12).pb(6).text_size(ts(13.5)).text_color(t.muted).child(c.text))
    .when(c.tickets.length > 0, (el) => el.child(v_flex().py(4).border_t(1).border_color(t.border).children(tickets)))
    .when(c.state === "done" && Boolean(c.summary), (el) => el.child(v_flex().px(12).pt(8).pb(10).gap(4).border_t(1).border_color(t.border)
      .child(div().text_size(ts(12.5)).text_color(t.dim).child("What the crew did"))
      .child(div().text_size(ts(13.5)).text_color(t.foreground).child(TextView.markdown(`cs${i}`, c.summary).selectable()))))
    .when(Boolean(foot), (el) => el.child(h_flex().px(12).pt(6).pb(10).gap(8).items_center().border_t(1).border_color(t.border)
      .when(live, (el) => el.child(div().size(6).flex_none().rounded(3).bg(color).loop("opacity", { from: 0.25, to: 1, period: 1200 })))
      .child(div().flex_1().text_size(ts(13)).text_color(c.state === "needs" ? t.blocked : t.dim).child(TextView.markdown(`cf${i}`, foot)))));
}
