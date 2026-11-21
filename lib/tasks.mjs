// A Claude session's own task list, read from its transcript without opening the chat (Mission's agent rows).
// Same rules as feed/kodr-feed.mjs: TaskCreate/TaskUpdate (a task exists once its result says "Task #N created"),
// or the last TodoWrite on older versions.
import { tailLines } from "./store.mjs";

// ponytail: tail only, so a task created more than TAIL bytes back is missed; read the whole file if lists go missing.
const TAIL = 8 * 1024 * 1024;
const MARK = /"(TaskCreate|TaskUpdate|TodoWrite)"|Task #\w+ created/;

/** Tasks in a transcript's lines: [{ content, activeForm?, status }], status pending | in_progress | completed. */
export function tasksOf(lines) {
  const tasks = new Map(), creating = new Map();
  let todos = null;
  for (const line of lines) {
    if (!MARK.test(line)) continue;
    let l;
    try { l = JSON.parse(line); } catch { continue; }
    if (l.isSidechain) continue;
    for (const b of Array.isArray(l.message?.content) ? l.message.content : []) {
      if (l.type === "assistant" && b.type === "tool_use") {
        if (b.name === "TodoWrite") todos = b.input?.todos ?? null;
        if (b.name === "TaskCreate") creating.set(b.id, { content: b.input?.subject ?? "", activeForm: b.input?.activeForm });
        const task = b.name === "TaskUpdate" && tasks.get(String(b.input?.taskId));
        if (task) {
          if (b.input.status) task.status = b.input.status;
          if (b.input.subject) task.content = b.input.subject;
        }
      } else if (l.type === "user" && b.type === "tool_result") {
        const out = typeof b.content === "string" ? b.content : (b.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
        const made = creating.get(b.tool_use_id), n = /Task #(\w+) created/.exec(out)?.[1];
        if (made && n) tasks.set(n, { ...made, status: "pending" });
      }
    }
  }
  if (tasks.size) todos = [...tasks.values()].filter((x) => x.status !== "deleted");
  return todos ?? [];
}

export const readTasks = (transcript) => (transcript ? tasksOf(tailLines(transcript, TAIL)) : []);

if (process.argv[1]?.endsWith("tasks.mjs")) {
  const assert = (await import("node:assert/strict")).default;
  const j = (o) => JSON.stringify(o);
  const use = (id, name, input) => j({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });
  const res = (id, text) => j({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } });
  // Created, one done, one deleted, an update before its creation landed is ignored, a sidechain doesn't count.
  const t = tasksOf([
    use("c1", "TaskCreate", { subject: "One", activeForm: "Doing one" }), res("c1", "Task #1 created successfully: One"),
    use("c2", "TaskCreate", { subject: "Two" }), use("u0", "TaskUpdate", { taskId: "2", status: "completed" }),
    res("c2", "Task #2 created successfully: Two"),
    use("c3", "TaskCreate", { subject: "Three" }), res("c3", "Task #3 created successfully: Three"),
    use("u1", "TaskUpdate", { taskId: "1", status: "completed" }), use("u2", "TaskUpdate", { taskId: "3", status: "deleted" }),
    j({ type: "assistant", isSidechain: true, message: { content: [{ type: "tool_use", id: "s", name: "TodoWrite", input: { todos: [{ content: "x" }] } }] } }),
    "not json {",
  ]);
  assert.deepEqual(t.map((x) => [x.content, x.status]), [["One", "completed"], ["Two", "pending"]]);
  // Older sessions: the last TodoWrite wins.
  assert.deepEqual(tasksOf([use("a", "TodoWrite", { todos: [{ content: "a", status: "pending" }] }), use("b", "TodoWrite", { todos: [{ content: "b", status: "completed" }] })]), [{ content: "b", status: "completed" }]);
  assert.deepEqual(tasksOf([]), []);
  assert.deepEqual(readTasks(null), []);
  console.log("tasks: ok");
}
