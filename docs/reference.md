# Kodr reference

Every feature in detail, with the command names scripts and keys can use. The README has the overview.

## Use
- `node bin/install.mjs` installs the mods, the Zed-style theme and the `kodr` layout into herdr,
  and adds **Claude (Kodr)** to herdr's new-agent menu (`+`).
- In any Claude Code pane, **Terminal | Chat** in the header switches views (`kodr-pane.toggle`). Each agent keeps
  the view you last picked: clicking it in the Agents sidebar opens its chat while that's open. The switch is there only while a Claude runs in the terminal: when it exits, or is killed or crashes inside a shell (herdr keeps calling such a pane Claude Code), the header says shell, the switch goes, and an open chat closes back to the terminal (`feed/kodr-alive.mjs` checks the process tree). A Claude not
  started from Claude (Kodr) is attached on the way (`feed/kodr-attach.mjs`): chat works, but permission cards,
  checkpoints and checks need the Kodr hooks.
- Herdr restarts lost terminals (its core restarted or updated, a reboot) as shells and never reruns their command.
  When herdr starts, Kodr types `claude --resume <session>` (its launch) into each such shell whose Claude session
  never ended and runs nowhere else, and that herdr started after that Claude last wrote (a Claude killed in a shell you started stays down), once per terminal and session, and says how many it resumed (`feed/kodr-resume.mjs`).
- Text typed in the terminal and not sent moves into the chat's box when you're in the chat (or when you send from
  it), and leaves the terminal (Ctrl+Y there brings it back). Left there, it would hold the chat's message for up to a
  minute and then land in front of it (`mod/kodr-chat/draft.js`).
- While Claude works, Enter steers (stops the current step and sends) or queues, as the composer's
  **Queue | Steer** switch says; Ctrl+Enter does the other.
- The chat reads like the terminal folds it: your message as a bubble on the right, one "Worked for 1m 32s · 6 tool
  calls · 2 edits ›" line holding the turn's narration, thinking and tool calls (click to open), the answer, and a
  changed-files card with Review →. While Claude works, the line reads "Working for …" over what it last said and a live
  block mirroring the terminal's spinner and current step; permission and question cards never hide in the fold.
- The chat: `/` commands, `$` skills, `@` files, paste an image, drop a file. The menus list everything Claude would:
  your and the project's skills and commands, enabled plugins' (including skills a plugin's manifest lists in subfolders),
  skills synced from claude.ai (`anthropic-skills:`), and Claude's bundled ones (`simplify`, `loop`, …). `/` shows skills
  too; `$` only skills. Typing filters by name, then by description; the list scrolls; ↑ ↓ move, Enter or Tab picks,
  Esc closes. From a script: `kodr-chat.compose:<terminal>:<text>` and `kodr-chat.menu-down:<terminal>`. Claude's questions,
  plans and permission asks are cards; Allow/Deny/Answer here or in the terminal. The mode menu
  (`kodr-chat.modes`, or `kodr-chat.mode-<manual|acceptEdits|auto|plan|bypass>` for a key) switches Ask, Accept edits, Auto, Plan and Bypass. The same menu sets the chat's **Text size** (Small, Medium, Large) and **Font** (Zed, the default: Zed's IBM Plex Sans with Lilex for code, shipped in `mod/kodr-chat/fonts/`; Herdr; System; Mono: your terminal font), for every chat (`kodr-chat.size-<s|m|l>`, `kodr-chat.font-<zed|default|system|mono>`).
  Every code block in a reply has Copy; a turn's end line has Copy and Quote for its last reply (on hover); an open tool shows
  Copy on its command. New rows fade in; scrolled up, the chat stays put and offers Jump to latest.
  Claude's thinking, which the terminal shows and which often carries its progress notes, is a muted line among the
  tool calls; a click shows all of it.
  A picture a tool brought back (a Read of a PNG, a browser screenshot) shows under the turn line, with the call that
  made it; the feed keeps each in herdr's `data/kodr-chat/img/`, since mods draw images only from there.
  `Ctrl+F` finds in the chat: every match marked in the text and counted ("2 of 5"; the current one brighter, and a folded Worked line says how many it hides), Enter / ↑ the older hit, Shift+Enter / ↓ the newer, Esc
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
  `npm run dev` included). Enter (or **Pane**) opens it in a Browser pane beside the focused pane; **Deft** opens it in
  Deft (a browser extension that lets the agent drive your browser; not published yet; the button shows only when Deft is
  installed); Ctrl+Enter or **Browser** opens the default browser. `feed/kodr-ports.mjs` does the scan and the Deft call.
- Browser pane (herdr-browser, in `browser/`, also published on its own as noxire-dev/herdr-browser; Kodr's install
  installs it): a web page inside herdr. Herdr's mods can't embed a webview, so the pane shows a
  headless Chromium (Edge or Chrome, found by `browser/browser.mjs`; `HERDR_BROWSER` picks another) through CDP
  screencast frames, and sends clicks, drags, the wheel and keys back over CDP. One Chromium per machine, on CDP port
  9333 (`HERDR_BROWSER_PORT`), with its own profile in `~/.herdr-browser/profile` (extensions and sync off): your real
  browser is never touched. Opened blank with `Ctrl+Shift+I` (`kodr-pane.browser`, beside the focused pane), from Preview, by Ctrl/Cmd-clicking a `localhost` / `127.0.0.1` link in a terminal
  (the `kodr` layout's `link_handlers`; other links still go to your browser), or by
  `herdr-app do pane.split '{"direction":"right","mod":"herdr-browser","props":{"url":"http://localhost:3000","key":"any"}}'`.
  - Each pane is one Chromium window, and its tabs are that window's pages. The tab strip shows with two tabs or
    more; a tab's × closes it. Ctrl+T (Cmd on macOS) or **+** opens a tab, Ctrl+W closes one, Ctrl+Tab cycles. A link
    that opens a new tab or window opens in the strip. Closing the last tab leaves a blank one: a pane is never empty.
  - Toolbar: back, forward, reload (stop while loading, with a line under the bar), the address (a URL, a bare port
    like `3000` for `http://localhost:3000`, or words to search), **+** (new tab), **CDP 9333** (copies
    `http://127.0.0.1:9333`) and open in the default browser.
  - States: Starting the browser…; Loading…; the page; `about:blank` shows how to start; Couldn't start the browser
    (no Edge/Chrome, or the port is taken) with Retry; The browser closed, with Reopen.
  - Agents: Kodr's Claude gets the `herdr-browser` MCP server (`browser/browser.mjs --mcp`, added with
    `--mcp-config ~/.kodr-herdr/mcp.json`; needs Node 22+). The tools are `browser/tools.mjs`, ported from
    Deft's CDP mode, with `browser/page.js` run in an isolated world of the page: `read_page` (page text
    plus numbered elements, a third of Playwright's tokens), `click`, `type`,
    `scroll`, `navigate` (`new_tab`), `switch_tab`, `list_tabs`, `close_tabs`, `screenshot`. Its first call starts the
    Chromium and, when no pane is open, splits one off the focused pane. The pane shows whichever of its tabs was
    activated last, by you or an agent; a new tab from an agent opens in the pane you last clicked into. Playwright
    `chromium.connectOverCDP("http://127.0.0.1:9333")` works too.
  - A pane's tabs survive a mod reload and a herdr restart (it reattaches to its window); closing the pane closes its
    tabs. `node browser/browser.mjs --stop` closes the Chromium; `--uninstall` does too.
  - Clipboard: Ctrl+C/X/V (Cmd on macOS) use your system clipboard. Ctrl+Shift chords stay herdr's.
  - Limits: it's frames, not a native view: expect some lag on animation and video, no IME, no file pickers or
    downloads, and the display scale is 1 on Windows/Linux, 2 on macOS (herdr doesn't expose it).

`.kodr/checks.json`: `{ "setup": "npm ci", "pin": ["test/**", "**/*.test.js"], "checks": [{ "name": "test", "run": "npm test" }] }`.
Pinned paths are put back as the base commit has them before the checks run, so editing a test can't make it pass.
Bypass is offered (the session starts with `--allow-dangerously-skip-permissions`) but never the default.

## Keys (kodr layout)
- `Ctrl+Shift+J`: Terminal | Chat. `Ctrl+Shift+R`: Review, on this session. `Ctrl+Shift+M`: permission modes and chat options. `Ctrl+F` (in a chat): find. `Ctrl+Shift+U`: Preview. `Ctrl+Shift+I`: a Browser pane.
- The installer adds these to `keys.json` under `layout:kodr`, only where the key is free.
- Task lists need `CLAUDE_CODE_ENABLE_TASKS=true` in Claude's environment.

## Pieces
- `hooks/kodr-hook.mjs`: SessionStart, PermissionRequest and Stop hooks, loaded only via
  `claude --settings ~/.kodr-herdr/claude-settings.json`. `kodr-verify.mjs` runs checks detached.
- `feed/kodr-feed.mjs`: the transcript's tail as chat rows; `feed/kodr-complete.mjs`: commands, skills, files.
- `mod/kodr-chat`, `mod/kodr-pane`, `mod/kodr-review`, `mod/kodr-preview` (with `feed/kodr-ports.mjs`), `browser/` (herdr-browser: `mod/herdr-browser`, `browser.mjs`, `tools.mjs`, `install.mjs`); `herdr/` theme and layout.

Self-checks: `node lib/checkpoint.mjs`, `node lib/verify.mjs`, `node feed/kodr-feed.mjs --self-check`, `node hooks/kodr-hook.check.mjs`, `node mod/kodr-chat/blocks.check.mjs`, `node mod/kodr-chat/turns.check.mjs`, `node feed/kodr-mission.mjs --self-check`, `node feed/kodr-ports.mjs --self-check`, `node lib/tasks.mjs`, `node feed/kodr-yap.mjs --self-check`, `node feed/kodr-stages.mjs --self-check`, `node feed/kodr-todo.mjs --self-check`, `node feed/kodr-crew.mjs --self-check`, `node mod/kodr-mission/board.check.mjs`, `node mod/kodr-pane/attention.check.mjs`, `node browser/mod/herdr-browser/input.check.mjs`, `node browser/browser.mjs --self-check`, `node browser/tools.check.mjs`.
