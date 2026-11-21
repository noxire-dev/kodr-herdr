# Kodr reference

Every feature in detail, with the command names scripts and keys can use. The README has the overview.

## Use
- `node bin/install.mjs` installs the mods, the Zed-style theme and the `kodr` layout into herdr,
  and adds **Claude (Kodr)** to herdr's new-agent menu (`+`).
- In any Claude Code pane, **Terminal | Chat** in the header switches views (`kodr-pane.toggle`). A Claude not
  started from Claude (Kodr) is attached on the way (`feed/kodr-attach.mjs`): chat works, but permission cards,
  checkpoints and checks need the Kodr hooks.
- While Claude works, Enter steers (stops the current step and sends) or queues, as the composer's
  **Queue | Steer** switch says; Ctrl+Enter does the other.
- The chat reads like the terminal folds it: your message as a bubble on the right, one "Worked for 1m 32s · 6 tool
  calls · 2 edits ›" line holding the turn's narration, thinking and tool calls (click to open), the answer, and a
  changed-files card with Review →. While Claude works, the line reads "Working for …" over what it last said and a live
  block mirroring the terminal's spinner and current step; permission and question cards never hide in the fold.
- The chat: `/` commands, `$` skills, `@` files, paste an image, drop a file. Claude's questions,
  plans and permission asks are cards; Allow/Deny/Answer here or in the terminal. The mode menu
  (`kodr-chat.modes`, or `kodr-chat.mode-<manual|acceptEdits|auto|plan|bypass>` for a key) switches Ask, Accept edits, Auto, Plan and Bypass.
  Every code block in a reply has Copy; a turn's end line has Copy and Quote for its last reply; an open tool shows
  Copy on its command. New rows fade in; scrolled up, the chat stays put and offers Jump to latest.
  Claude's thinking, which the terminal shows and which often carries its progress notes, is a muted line among the
  tool calls; a click shows all of it.
  A picture a tool brought back (a Read of a PNG, a browser screenshot) shows under the turn line, with the call that
  made it; the feed keeps each in herdr's `data/kodr-chat/img/`, since mods draw images only from there.
  `Ctrl+F` finds in the chat: hits marked in the text, "2 of 5", Enter / ↑ the older hit, Shift+Enter / ↓ the newer, Esc
  closes; the current hit opens its turn and scrolls into view. From a script: `kodr-chat.find:<terminal>:<query>`,
  `find-next:<terminal>`, `find-prev:<terminal>`, `find-close:<terminal>`.
- The kodr layout's Agents list (`mod/kodr-agents`, herdr's own list copied) puts each agent's stage under its row:
  the task Claude has in progress, else its `yap doing` line, with how far through its task list it is ("Adding the
  stage line 2/5"). Agents with neither keep herdr's one-line row. Data: `feed/kodr-stages.mjs`.
- The crew in the chat (with [yap](https://github.com/noxire-dev/yap)): when the chat's Claude hands a goal to yap's
  crew (`yap goal "…"`, then `yap go`), the goal becomes a card after that turn. The card shows the goal's tickets,
  each with its status, its review round and the line its agent is on. It also shows what needs you (a ticket that ran
  out of review rounds) and, once everything merged, the crew's report, "What the crew did".
  The card's states are Planning, Drafts ready, Running, Needs you, Writing the report, Done, Failed and Dropped, plus
  "yap isn't running". The crew is yap's own: a planner drafts tickets with acceptance criteria, an agent works each
  ticket in its own worktree, a fresh reviewer checks it, and merges pass the repo's gate.
  Data: `feed/kodr-crew.mjs` reads the daemon's `/api/state`. A fixture chat can stand in for the daemon with
  `crew-state.json` in its `~/.kodr-herdr/t/<name>/` folder. Agents hear about the crew at SessionStart when yap is
  installed. yap also sends the crew's report to the session that handed the goal off, and wakes it; so does a ticket of that goal
  getting stuck (it needs a human). The chat folds that
  report into the goal's card, or shows it as a "Crew report" (stuck: an urgent "Crew needs you") when the goal has no card there (handed off from the
  terminal, say).
- Each turn ends with a checkpoint (`refs/kodr/checkpoints/<session>/<n>`) and, when the base
  commit has `.kodr/checks.json`, its checks. **Review →** opens the review tab
  (`kodr-review.next`, `kodr-review.reviewed`).
- Mission (the Mission button or `Ctrl+Shift+G`): one stack for the space's repo. **Agents**: the live Claudes in the
  repo, its worktrees or on its Rinai cards, with status, stage and tasks done/total; a click goes to one.
  **Todos**: Kodr's own board (`feed/kodr-todo.mjs`, `~/.kodr-herdr/boards/`, keyed by the main checkout so worktrees
  share it; works in a folder that isn't a git repo). Kodr's SessionStart hook tells each Claude the commands: `add
  "<title>" [--body]`, `start`, `note`, `block <id> "<why>"`, `done`, `list`, `show`, `edit`, `rm`. Grouped Blocked,
  Ongoing, In review, Todo, Done; a row shows its latest note. `+` adds one; a todo opens with its agent (the one that
  started it: Go to it), **Start a Claude on it** (a new tab in the space, told to take it), Move, Delete (asks once),
  its details and notes. Commands: `kodr-mission.todo-<N>`, `kodr-mission.add-todo`. **Issues · Rinai**: below, when
  `gh rinai` works there; otherwise one line saying why. **Needs you** (top, only when there is one): questions and blockers a live session sent you with `yap say --question|--blocker @user`; **Reply** answers with `--re`, which takes it off the list (it reaches the asker as "the user, through Kodr (unverified)": yap trusts only relay-paired devices as you, so a local app speaking for you is labelled, not verified). **Board · yap** (bottom): the repo's yap notes, each with Take down (asks once), and the live claims; "yap isn't running" when the daemon is down. Data: `feed/kodr-yap.mjs control`. A Rinai card with a worktree has
  **Review**: a read-only Claude (`claude -p`, Read/Grep/git diff only) reads the branch's diff against the default branch
  and the brief, and the card lists blockers, majors and minors with a fix each; **Send to its Claude** types the ones to
  fix into the card's agent. A new commit marks the review out of date. Review model: `reviewModel` in
  `~/.kodr-herdr/config.json` (or `KODR_REVIEW_MODEL`). The review never merges. After a clean review of the latest commit
  the card offers **Open PR** (pushes the branch, opens a PR into the default branch that closes the issue), **Push to PR**
  when the branch moved on, then **Squash and merge** (`gh pr merge --squash --match-head-commit`, the reviewed commit only),
  then Move to Done (Squash and merge moves it itself). After a merge the card's worktree and branch (local and on origin)
  go, and its Claude is ended, unless they hold work the merge doesn't (uncommitted changes, commits after the merged one):
  then the card says why they were kept. **Send to its Claude** arms review rounds: when that Claude's turn ends (the
  Stop hook), the review runs again, and what's left goes back to it, up to the round limit; the card shows "Round N of M".
  Rows and cards show the card Claude's task list (done/total) and how long its session has run.
  Repo settings (the gear, or `kodr-mission.settings`; `~/.kodr-herdr/repos.json` by owner/repo, this machine only):
  a **setup command** run in a new worktree before its Claude starts (the card shows it running; failed shows the output
  with Retry setup / Start anyway), an **accept command** run in the main checkout after a card moves to Done (shown on
  the Done card), **review rounds** (default 3), and **auto-merge**, off by default: on, a clean review of the latest
  commit opens the PR, squash-merges it, cleans up and moves the card to Done by itself. Auto steps are logged to
  `~/.kodr-herdr/mission.log`. `kodr-mission.open-<N>` opens a card.
- Desktop notifications (Windows): when a Claude needs you or finishes while you're elsewhere. Per space in the
  `Ctrl+Shift+M` menu: All, Needs me (only permissions and questions), Off.
- Preview (`Ctrl+Shift+U`, `mod.open:kodr-preview`): the dev servers running in herdr's terminals, the shown space's
  first: any local port that answers HTTP and whose process descends from a terminal (an agent's background
  `npm run dev` included). Enter opens it in Deft (a browser extension that lets the agent drive your browser; not published yet), a new tab in the browser the agent drives through
  Deft's MCP tools, so both of you see the same page; Ctrl+Enter or **Browser** opens the default browser instead.
  `feed/kodr-ports.mjs` does the scan and the Deft call. Deft reaches Kodr sessions as a user-scope MCP server; Kodr adds nothing.

`.kodr/checks.json`: `{ "setup": "npm ci", "pin": ["test/**", "**/*.test.js"], "checks": [{ "name": "test", "run": "npm test" }] }`.
Pinned paths are put back as the base commit has them before the checks run, so editing a test can't make it pass.
Bypass is offered (the session starts with `--allow-dangerously-skip-permissions`) but never the default.

## Keys (kodr layout)
- `Ctrl+Shift+J`: Terminal | Chat. `Ctrl+Shift+R`: Review, on this session. `Ctrl+Shift+M`: permission modes and chat options. `Ctrl+F` (in a chat): find. `Ctrl+Shift+U`: Preview.
- The installer adds these to `keys.json` under `layout:kodr`, only where the key is free.
- Task lists need `CLAUDE_CODE_ENABLE_TASKS=true` in Claude's environment.

## Pieces
- `hooks/kodr-hook.mjs`: SessionStart, PermissionRequest and Stop hooks, loaded only via
  `claude --settings ~/.kodr-herdr/claude-settings.json`. `kodr-verify.mjs` runs checks detached.
- `feed/kodr-feed.mjs`: the transcript's tail as chat rows; `feed/kodr-complete.mjs`: commands, skills, files.
- `mod/kodr-chat`, `mod/kodr-pane`, `mod/kodr-review`, `mod/kodr-preview` (with `feed/kodr-ports.mjs`); `herdr/` theme and layout.

Self-checks: `node lib/checkpoint.mjs`, `node lib/verify.mjs`, `node feed/kodr-feed.mjs --self-check`, `node hooks/kodr-hook.check.mjs`, `node mod/kodr-chat/blocks.check.mjs`, `node mod/kodr-chat/turns.check.mjs`, `node feed/kodr-mission.mjs --self-check`, `node feed/kodr-ports.mjs --self-check`, `node lib/tasks.mjs`, `node feed/kodr-yap.mjs --self-check`, `node feed/kodr-stages.mjs --self-check`, `node feed/kodr-todo.mjs --self-check`, `node feed/kodr-crew.mjs --self-check`, `node mod/kodr-mission/board.check.mjs`, `node mod/kodr-pane/attention.check.mjs`.
