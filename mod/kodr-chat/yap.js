// YAP in the chat: messages other sessions (or the person) sent this one, its own replies, and a
// strip of who else works in the repo. Drawing only; the view keeps the state (view.yap, view.answering).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, TextView } from "gpui-base";
import { icon, button } from "./cards.js";
import { ts } from "./size.js";
import { chip } from "./cards.js";

const TYPE = { question: "Question", blocker: "Blocker", note: "Note on the board", goal: "Crew report", stuck: "Crew needs you" };
const ago = (at) => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  return s < 60 ? "now" : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
};

// A message to or from another session. Incoming ones from a session can be answered here.
export function yapRow(view, r, i, t) {
  if (r.dir === "out") {
    // What this session sent: a quiet row in the same inset as the cards, readable.
    return h_flex().id(`y${i}`).my(4).min_h(26).gap(8).items_start().px(12).py(4).rounded(4).bg(t.chrome).text_size(ts(13.5))
      .child(div().pt(2).flex_none().text_color(t.dim).child(svg(icon("yap")).size(14)))
      .child(div().flex_none().text_color(t.muted).child(`${r.type === "say" ? "Told" : r.type === "question" ? "Asked" : "Blocked on"} ${r.to}`))
      .child(div().flex_1().min_w(0).text_color(t.foreground).child(r.text));
  }
  const urgent = r.type === "question" || r.type === "blocker" || r.type === "stuck";
  const key = `y${i}`;
  const replying = view.answering?.key === key;
  // YAP delivers only to running sessions: once the sender has ended (and the daemon says so), say that instead of offering Reply.
  const peers = view.yap?.peers;
  const ended = Boolean(r.sender) && Boolean(peers) && !peers.some((p) => p.name === r.sender || p.id.startsWith(r.sender) || r.sender.startsWith(p.id));
  return v_flex().id(key).my(8).rounded(8).border_1().border_color(urgent ? t.blocked : t.border).bg(t.chrome).overflow_hidden()
    .child(h_flex().px(12).pt(9).gap(8).items_center()
      .child(svg(icon("yap")).size(14).flex_none().text_color(urgent ? t.blocked : t.dim))
      .child(div().flex_none().text_size(ts(13.5)).font_medium().text_color(t.foreground).child(r.from))
      .when(Boolean(TYPE[r.type]), (el) => el.child(chip(TYPE[r.type], urgent ? t.blocked : t.muted)))
      .when(Boolean(r.re), (el) => el.child(div().text_size(ts(12.5)).text_color(t.dim).child(`answering ${r.re}`)))
      .child(div().flex_1()))
    .child(div().px(12).pt(6).pb(r.sender ? 4 : 10).text_color(t.foreground).child(TextView.markdown(`ym${i}`, r.text).selectable()))
    .when(ended, (el) => el.child(div().px(12).pb(10).text_size(ts(13)).text_color(t.dim).child(`${r.from} has ended; yap only reaches running sessions.`)))
    .when(Boolean(r.sender) && !ended && !replying, (el) => el.child(h_flex().px(8).pb(8).gap(6)
      .child(h_flex().id(`yr${i}`).h(24).px(8).gap(6).items_center().rounded(4).cursor_pointer().text_size(ts(13)).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => view.startReply(key, r, cx))
        .child(svg(icon("reply")).size(13)).child(urgent ? "Answer" : `Reply to ${r.from}`))))
    .when(replying, (el) => el.child(h_flex().px(10).pb(10).gap(6).items_center()
      .child(Input.new(view.answering.input).flex_1().h(28).px(8).rounded(4).border_1().border_color(t.border).bg(t.background).text_size(ts(13.5)))
      .child(button(`ys${i}`, "Send", t, "primary", (cx) => view.sendReply(cx), !view.answering.input.value().trim()))
      .child(button(`yc${i}`, "Cancel", t, "plain", (cx) => { view.answering = null; cx.notify(); }))))
    .when(replying && Boolean(view.answering.error), (el) => el.child(div().px(12).pb(8).text_size(ts(12.5)).text_color(t.blocked).child(view.answering.error)));
}

// One line above the composer: who else is here and what needs attention; open, the details.
export function yapStrip(view, t) {
  const y = view.yap, peers = y.peers ?? [], claims = y.claims ?? [];
  const conflicts = [...(y.self?.conflicts ?? []), ...peers.flatMap((p) => p.conflicts ?? [])];
  const waiting = y.self?.unanswered?.length ?? 0;
  const open = view.yapOpen;
  // Alone, no claims, nothing waiting: nothing to say, so no strip.
  if (!peers.length && !claims.length && !waiting && !conflicts.length) return div();
  const bits = [
    peers.length ? `${peers.length} other session${peers.length > 1 ? "s" : ""}` : null,
    claims.length ? `${claims.length} claim${claims.length > 1 ? "s" : ""}` : null,
    waiting ? `${waiting} waiting on an answer` : null,
  ].filter(Boolean);
  return v_flex().id("yap").mb(6).rounded(8).border_1().border_color(t.border).bg(t.chrome).overflow_hidden()
    .child(h_flex().id("yap-head").h(30).px(10).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { view.yapOpen = !view.yapOpen; cx.notify(); })
      .child(svg(icon("peers")).size(14).text_color(t.dim))
      .child(div().flex_none().text_size(ts(13)).text_color(t.muted).child("yap"))
      .child(div().flex_1().min_w(0).truncate().text_size(ts(13)).text_color(t.dim).child(bits.join(" · ")))
      .when(conflicts.length > 0, (el) => el.child(div().flex_none().text_size(ts(12.5)).text_color(t.blocked).child(`${conflicts.length} conflict${conflicts.length > 1 ? "s" : ""}`)))
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).text_color(t.dim)))
    .when(open, (el) => el.child(v_flex().px(10).py(6).gap(2).border_t(1).border_color(t.border)
      .children(peers.map((p, k) => h_flex().id(`yp${k}`).min_h(24).gap(8).items_center().text_size(ts(13.5))
        .child(div().size(6).flex_none().rounded(3).bg(Date.now() - p.at < 120_000 ? t.done : t.dim))
        .child(div().flex_none().text_color(t.foreground).child(`@${p.name}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(p.doing || (p.files ? `${p.files} file${p.files > 1 ? "s" : ""} edited` : "no edits yet")))
        .when((p.conflicts ?? []).length > 0, (el) => el.child(div().text_size(ts(12.5)).text_color(t.blocked).child(`conflicts: ${p.conflicts.flatMap((c) => c.files).slice(0, 2).join(", ")}`)))
        .child(div().flex_none().text_size(ts(12.5)).text_color(t.dim).child(ago(p.at)))))
      .when(peers.length === 0, (el) => el.child(div().py(2).text_size(ts(13)).text_color(t.dim).child("No other session is working in this repo.")))
      .when(claims.length > 0, (el) => el.child(div().pt(6).text_size(ts(12.5)).text_color(t.dim).child("Claims")))
      .children(claims.map((c, k) => h_flex().id(`yc${k}`).min_h(22).gap(8).items_center().text_size(ts(13))
        .child(div().flex_none().font_family("monospace").text_color(t.muted).child(c.path))
        .child(div().flex_none().text_color(c.mine ? t.accent : t.dim).child(c.mine ? "yours" : `@${c.name}`))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(c.why))))
      .when(waiting > 0, (el) => el.child(div().pt(6).text_size(ts(12.5)).text_color(t.dim).child("Waiting on an answer")))
      .children((y.self?.unanswered ?? []).map((q, k) => div().id(`yu${k}`).text_size(ts(13)).text_color(t.muted).truncate().child(`${q.kind}: ${q.text}`)))));
}
