# herdr-browser

A browser pane for herdr-app that agents drive over MCP. Node only; Windows and macOS.

This repo is published from [Kodr](https://github.com/noxire-dev/kodr-herdr)'s `browser/` folder (`node bin/publish.mjs
"<msg>" --browser --push` there). Changes land in Kodr; this folder must not depend on Kodr.

## Pieces

- `mod/herdr-browser/`: the pane. A window of the headless browser per pane, drawn from CDP screencast frames
  (`main.js`); input mapping, address parsing and the tab strip's order (`input.js`); the link handler (`link.js`).
  Frames go to `~/.config/herdr-app/mods/herdr-browser-frames/` as SVGs wrapping a JPEG: herdr's `fs.writeFile` drops
  binary data, refreshes a changed image only under `mods/`, and rewriting a shown file races its reload, so each frame
  gets a new name. herdr evicts decoded images over a memory budget even while they're drawn, so a frame declares half
  its size (it still rasterizes sharp), frames are capped at 4 a second, and three are stacked (newest, loading,
  loaded).
- `browser.mjs`: starts or finds the browser (one per machine, CDP port 9333, profile in `~/.herdr-browser/profile`);
  `--mcp` is the MCP server, which opens a pane before a tool call when none is open.
- `tools.mjs` + `page.js`: the agent tools over CDP; `page.js` runs in an isolated world of the page. `Cdp` is the I/O
  edge; `tools.check.mjs` fakes it.
- `install.mjs`: installs the mod, writes `~/.herdr-browser/config.json`, registers the MCP server with Claude Code.

## Try a change

`HERDR_APP_HOME=<scratch> node install.mjs --no-mcp` installs into a scratch herdr home. Screenshot in a tab you open
(`herdr-app shot x.png`) and close it after. To see what's really on screen, PrintWindow the herdr window: `herdr-app
shot` renders its own copy. Other sessions may switch herdr's tab while you sample.

## Checks

`node browser.mjs --self-check`, `node tools.check.mjs`, `node mod/herdr-browser/input.check.mjs`,
`herdr-app check mod/herdr-browser`.
