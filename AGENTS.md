# kodr-herdr

Kodr is a Windows-first take on shepherdr's idea for herdr-app: Claude Code's own terminal, with a
structured chat you can switch to in the same pane, plus what shepherdr doesn't do: a git
checkpoint per turn, checks Kodr runs from the base commit (the agent can't edit them), and a
review queue. Node only, no Python or shell: it must run on Windows and macOS.

Scope on purpose: chat (permission, question and plan cards, tasks, diffs, / $ @ completion), the Terminal | Chat switch, checkpoints, checks, review, Preview (dev servers in the terminals) and the Browser pane (`browser/`: herdr-browser, a headless Chromium drawn from CDP frames, a window per pane with tabs, which Kodr's Claude drives through the `herdr-browser` MCP server, `browser/tools.mjs` over CDP port 9333). `browser/` is also its own repo, noxire-dev/herdr-browser (`node bin/publish.mjs --browser`): keep it free of Kodr (its own config in `~/.herdr-browser`, its own `install.mjs`, which Kodr's install calls).
Not tasks, web app, voice or autopilot.

## Pieces
- `hooks/kodr-hook.mjs`: Claude hooks, loaded only via `claude --settings ~/.kodr-herdr/claude-settings.json`
  (never the user's ~/.claude/settings.json). `kodr-verify.mjs` runs checks detached.
- `feed/kodr-feed.mjs`: transcript tail → chat rows (the chat mod execs it).
- `mod/kodr-chat`, `mod/kodr-pane` (pane header with the switch), `mod/kodr-agents` (herdr's agents list + each agent's stage; re-copy when herdr updates `agents`), `mod/kodr-review`, `browser/mod/herdr-browser` (frames go to `~/.config/herdr-app/mods/herdr-browser-frames/`: herdr only refreshes a changed image under `mods/`, skips dot-folders, and reloads a mod when its own folder changes; each frame gets a new name, since rewriting a shown file races herdr's reload, and three are stacked: the newest over one loading over one that stayed on screen 1 s, so loaded. herdr evicts decoded images over a memory budget, so a frame SVG declares half its size (it still rasterizes sharp) and frames are capped at 4 a second, or the frames on screen get evicted and the pane blinks).
- `lib/`: checkpoint, verify, per-terminal state in `~/.kodr-herdr/t/<terminal>/` (see lib/store.mjs).
- `herdr/`: the Zed-style theme and the `kodr` layout (the person's `main` layout is never edited).

## Try a change
`node bin/install.mjs` copies mods, theme and layout into `~/.config/herdr-app` (set `HERDR_APP_HOME`
to install into a scratch herdr home instead). Run agents in a scratch git repo on Haiku
(`--model haiku`); add `--permission-mode default` to see permission cards (the person's default is
bypass). `herdr-app shot x.png` captures the window; `herdr-app status` shows mod errors. Nothing can hover or click in
the window, so hover-only controls never show in a shot: `herdr-app do kodr-chat.hovers` draws them all (run it again
to stop). Mission's merge, setup and accept steps run against `noxire-dev/issues-scratch` (clone it to a scratch folder; set its
repo settings with `node feed/kodr-mission.mjs settings <clone> '{...}'` and put them back after). To type into a fixture shell from inside a Herdr terminal use `env -u HC_TERMINAL_ID hc send <t> <text>`: with
HC_TERMINAL_ID set, hc wraps the text in `<hc from=…>`, which a shell can't run. Screenshot in a tab you open on a fixture session (`~/.kodr-herdr/t/<name>/session.json` + a transcript), never
in the person's tabs, and close it after: they may be typing there.

## Checks
`node lib/checkpoint.mjs`, `node lib/verify.mjs`, `node feed/kodr-feed.mjs --self-check`, `node hooks/kodr-hook.check.mjs`, `node mod/kodr-chat/blocks.check.mjs`, `node mod/kodr-chat/turns.check.mjs`, `node feed/kodr-mission.mjs --self-check`, `node mod/kodr-mission/board.check.mjs`, `node mod/kodr-pane/attention.check.mjs`, `node feed/kodr-ports.mjs --self-check`, `node lib/tasks.mjs`, `node feed/kodr-yap.mjs --self-check`, `node feed/kodr-stages.mjs --self-check`, `node feed/kodr-todo.mjs --self-check`, `node feed/kodr-crew.mjs --self-check`, `node feed/kodr-complete.mjs --self-check`, `node feed/kodr-resume.mjs --self-check`, `node feed/kodr-alive.mjs --self-check`, `node browser/mod/herdr-browser/input.check.mjs`, `node browser/browser.mjs --self-check`, `node browser/tools.check.mjs`, `node bin/publish.mjs --self-check`, and `herdr-app check mod/<name>` for each mod.

## Surfaces a change must hit
Windows and macOS paths; the terminal and chat views of the same session; herdr's Agents list (a
chat must never hide its agent); the review tab.

## Docs
README.md is for someone installing Kodr: what it is, install, uninstall, keys, what it writes where. docs/reference.md
has every feature in detail with command names. A behaviour change updates the reference, and the README when a user
would notice it. HANDOFF.md, NEEDS-YOU.md and docs/brief-*.md are working notes between sessions and the person: they stay in the
local repo and `bin/publish.mjs` leaves them out of the public one. README screenshots (docs/screenshots/) show demo
data only, with Herdr's sidebar cropped off: it lists the person's own spaces and agents.

## Finishing
Checks pass, each changed view seen in a screenshot in its states (hover states via `kodr-chat.hovers`), README and this file still true.
