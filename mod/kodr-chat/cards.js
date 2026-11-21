// The chat's richer cards: an edit's diff, Claude's questions (AskUserQuestion), its plan
// (ExitPlanMode), and its todo list (TodoWrite). Drawing only; the view keeps the state.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, TextView } from "gpui-base";

export const icon = (name) => `mods/kodr-chat/${name}.svg`;

// -/+ lines, as the feed computed them. "@@" separates the hunks of a MultiEdit.
export function diffView(lines, t, mono) {
  return v_flex().font_family(mono).text_size(12).py(4).children(lines.map((l, i) => {
    const add = l.startsWith("+"), del = l.startsWith("-"), gap = l === "@@", more = l.startsWith("… ");
    return h_flex().id(`dl${i}`).min_h(18).px(10)
      .when(add, (el) => el.bg(t.ansi2 + "1f")).when(del, (el) => el.bg(t.ansi1 + "1f"))
      .child(div().w(14).flex_none().text_color(add ? t.ansi2 : del ? t.ansi1 : t.dim).child(add ? "+" : del ? "−" : ""))
      .child(div().flex_1().min_w(0).text_color(gap || more ? t.dim : add || del ? t.foreground : t.muted)
        .child(gap ? "⋯" : more ? l : l.slice(1) || " "));
  }));
}

export function button(id, label, t, kind, onClick, disabled = false) {
  return div().id(id).px(10).h(24).flex().items_center().rounded(4).text_size(12)
    .when(disabled, (el) => el.text_color(t.dim).border_1().border_color(t.border))
    .when(!disabled, (el) => el.cursor_pointer().on_click((_e, cx) => onClick(cx))
      .when(kind === "primary", (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(kind !== "primary", (el) => el.border_1().border_color(t.border).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))))
    .child(label);
}

// Claude's question: each one with its options (one pick, or several), and room for an answer of
// one's own. view.qa holds what's picked; view.answerQuestions sends it.
export function questionCard(view, r, t) {
  const st = view.questionState(r.ask.id);
  const qs = r.detail?.questions ?? [];
  const ready = qs.length > 0 && qs.every((q, i) => (st.sel.get(i)?.size ?? 0) > 0 || (st.other.get(i)?.value().trim() ?? ""));
  return v_flex().id(`q-${r.ask.id}`).my(6).rounded(4).border_1().border_color(t.accent).bg(t.chrome).overflow_hidden()
    .children(qs.map((q, qi) => v_flex().id(`qq-${qi}`).px(12).pt(10).pb(8).gap(6).when(qi > 0, (el) => el.border_t(1).border_color(t.border))
      .child(h_flex().gap(8).items_center()
        .when(Boolean(q.header), (el) => el.child(div().px(6).h(18).flex().items_center().rounded(3).border_1().border_color(t.border).text_size(11).text_color(t.muted).child(q.header)))
        .child(div().flex_1().text_size(13).text_color(t.foreground).child(q.question))
        .when(Boolean(q.multiSelect), (el) => el.child(div().text_size(11).text_color(t.dim).child("pick any"))))
      .children((q.options ?? []).map((o, oi) => {
        const on = st.sel.get(qi)?.has(o.label);
        return h_flex().id(`qo-${qi}-${oi}`).px(8).py(6).gap(10).items_start().rounded(4).cursor_pointer()
          .border_1().border_color(on ? t.accent : t.border).when(on, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => view.pickOption(r.ask.id, qi, o.label, Boolean(q.multiSelect), cx))
          .child(div().mt(2).size(12).flex_none().rounded(q.multiSelect ? 2 : 6).border_1().border_color(on ? t.accent : t.dim).when(on, (el) => el.bg(t.accent)))
          .child(v_flex().flex_1().gap(1)
            .child(div().text_size(12.5).text_color(t.foreground).child(o.label))
            .when(Boolean(o.description), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(o.description))));
      }))
      .child(st.other.has(qi)
        ? Input.new(st.other.get(qi)).h(28).px(8).rounded(4).border_1().border_color(t.border).bg(t.background).text_size(12.5)
        : div().id(`qx-${qi}`).px(8).py(2).text_size(12).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => view.otherAnswer(r.ask.id, qi, cx)).child("Something else…"))))
    .child(h_flex().px(12).py(8).gap(6).items_center().border_t(1).border_color(t.border)
      .child(button(`qa-${r.ask.id}`, "Answer", t, "primary", (cx) => view.answerQuestions(r, cx), !ready))
      .child(button(`qd-${r.ask.id}`, "Skip", t, "plain", (cx) => view.answer(r.ask.id, { behavior: "deny", message: "The person skipped the question." }, cx)))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.dim).child("or answer in the terminal")));
}

// Claude's plan, to approve or send back. "Keep planning" sends the message box as feedback.
export function planCard(view, r, t) {
  return v_flex().id(`p-${r.ask.id}`).my(6).rounded(4).border_1().border_color(t.accent).bg(t.chrome).overflow_hidden()
    .child(h_flex().px(12).py(8).gap(8).items_center().border_b(1).border_color(t.border)
      .child(svg(icon("list")).size(14).text_color(t.accent))
      .child(div().flex_1().text_size(12.5).text_color(t.foreground).child("Claude's plan")))
    .child(div().id(`pm-${r.ask.id}`).px(14).py(10).max_h(420).overflow_y_scrollbar().text_color(t.foreground)
      .child(TextView.markdown(`plan-${r.ask.id}`, r.detail?.plan || "(no plan text)").selectable()))
    .child(h_flex().px(12).py(8).gap(6).items_center().border_t(1).border_color(t.border)
      .child(button(`pa-${r.ask.id}`, "Approve plan", t, "primary", (cx) => view.answer(r.ask.id, { behavior: "allow" }, cx)))
      .child(button(`pk-${r.ask.id}`, "Keep planning", t, "plain", (cx) => view.keepPlanning(r.ask.id, cx)))
      .child(div().flex_1())
      .child(div().text_size(11.5).text_color(t.dim).child("Keep planning sends your message as feedback")));
}

const TODO = { completed: ["check", "done"], in_progress: ["dot", "working"], pending: ["ring", "dim"] };

// The latest todo list, above the composer: one line folded, the list open.
export function todosPanel(view, todos, t) {
  const done = todos.filter((x) => x.status === "completed").length;
  const now = todos.find((x) => x.status === "in_progress");
  const open = view.todosOpen;
  return v_flex().id("todos").mb(6).rounded(4).border_1().border_color(t.border).bg(t.chrome).overflow_hidden()
    .child(h_flex().id("todos-head").h(30).px(10).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { view.todosOpen = !view.todosOpen; cx.notify(); })
      .child(svg(icon("list")).size(13).text_color(t.dim))
      .child(div().flex_none().text_size(12).text_color(t.muted).child(`Plan ${done}/${todos.length}`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(done === todos.length ? t.dim : t.foreground)
        .child(now ? now.activeForm ?? now.content : done === todos.length ? "All done" : ""))
      .child(svg(icon(open ? "chevron-down" : "chevron-right")).size(12).text_color(t.dim)))
    .when(open, (el) => el.child(v_flex().px(10).pb(8).gap(2).border_t(1).border_color(t.border).pt(6)
      .children(todos.map((x, i) => {
        const [mark, color] = TODO[x.status] ?? TODO.pending;
        return h_flex().id(`td${i}`).min_h(22).gap(8).items_center()
          .child(mark === "check" ? svg(icon("check")).size(12).flex_none().text_color(t[color])
            : div().size(8).mx(2).flex_none().rounded(mark === "dot" ? 1 : 4).border_1().border_color(t[color]).when(mark === "dot", (el) => el.bg(t[color])))
          .child(div().flex_1().text_size(12.5).text_color(x.status === "completed" ? t.dim : t.foreground).child(x.content));
      }))));
}
