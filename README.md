# Stratus OPs Companion (desktop shell) - Stage C

A small Windows app that opens https://stratusops.app/companion in its own window.
Stage A was the minimal secure shell, Stage B added the window behaviour, and Stage C (this
version, 0.3.0) adds the installer, automatic updates, the GitHub release workflow and signing
hooks. See **RELEASING.md** for how to publish a version. Stratus Link bundling and tracker
auto-update come in later stages.

## Run it (any computer with Node.js 20+)

    npm install
    npm start

To test against a preview or staging site:

    STRATUS_ORIGIN=https://your-preview-url npm start         (Mac/Linux)
    set STRATUS_ORIGIN=https://your-preview-url && npm start   (Windows cmd)

## Test

    npm test            unit tests (navigation rules, window-settings logic)
    npm run smoke       end-to-end check against a fake local site (needs a display;
                        on Linux: xvfb-run -a npx electron --no-sandbox --user-data-dir=/tmp/s scripts/smoke.js)

## Build for Windows

    npm run dist

The installer (`StratusOPsCompanion-Setup.exe`) must be built on Windows (or by GitHub Actions,
which RELEASING.md sets up). For a quick unpacked copy on any machine:
`npx electron-builder --config electron-builder.config.js --win zip --x64`.

## What it does

**Windows**
- Companion window: 420 x 680 standard, 420 x 160 compact (minimum 320 x 120), dark, no menu bar.
- Always on top (on by default). Position, each layout's size, layout, always-on-top and
  opacity are remembered. A saved position on a monitor that has since been unplugged is
  discarded so the window never opens off-screen.
- Closing the window hides it to the tray (one-time notice). Quit is in the tray menu.
- Only one copy runs; a second launch brings the first to the front.

**Tray menu (right-click; left-click shows/hides)**
- Show/Hide, Always on top, Compact mode, Opacity (100/85/70%)
- Open full site / Back to Companion, Open in my browser
- Sign out / switch account, Quit

**Keys**: Ctrl+Shift+F9 toggles Compact (works while a game has focus). F5 / Ctrl+R reload.
Alt+Left goes back (and returns from the full site to the Companion). The shortcut is the `COMPACT_SHORTCUT` constant in `src/main.js`.

**One window, same sign-in**
- The app only ever has one window. "Open Job Board" / "Open full site" load the site in that
  same window, which grows to the full-site size (remembered separately, default 1280 x 800) and
  stops floating on top so it never covers the simulator.
- To return to the small Companion: the floating **Back to Companion** button (bottom-right of every full-site page), Alt+Left (or the site's own Back), tray menu "Back to
  Companion", or the Compact shortcut. The window shrinks back to where it was, always-on-top
  again. The site's "Open Companion" button on the Connections page does the same.
- The account always matches the Companion; the browser's account is never used.
- Other websites always open in the default browser. Plain http and non-web links are blocked.
- Sign out clears the app's stored sign-in and returns to the small sign-in page; the next
  person who opens the app sees the sign-in page.

**Version**: shown in the tray menu, the tray tooltip, and as "App v<version>" in the Companion page's footer
(injected by the shell; if the page's footer changes shape it simply isn't shown).

**Updates**: copies installed with the installer check for updates after start and every 4 hours,
download quietly, show a notification, and install on "Restart to update" (tray) or next quit.
Zip and development copies skip updating.

**Errors**: no connection, or a 500-level server error, shows a "Can't reach Stratus OPs" page
with automatic retry (15 s), a Retry button and F5. A 404 shows the website's own page.

**Security**: context isolation on, Node integration off, sandbox on, no webviews, all permission
prompts denied, the app may only ever load its own offline page from disk.

## Known limits

- Always-on-top does not show over a game in true exclusive fullscreen; use windowed/borderless.
- Sign-in flows that leave the site (for example linking a Discord account) open in the browser
  and may not complete there. Use "Open in my browser" for those.
- The web page's own layout button is hidden because the shell owns the layout. This relies on
  the button label "Switch to ... layout" and the storage key `stratus-companion-compact`.
  If the page changes, the button may reappear; nothing breaks.
- Placeholder icon (assets/icon.png and assets/icon.ico) until the real Stratus OPs logo file is
  supplied; see RELEASING.md.
- Unsigned until signing secrets are added (RELEASING.md); Windows SmartScreen will warn.

## If a new version seems to behave like the old one

Closing the window only hides the app to the tray, and only one copy can run at a time. If an
older copy is still running, starting a newer one just brings the old one forward. Right-click the
tray icon, check the version line, choose Quit, then start the new version. (From 0.2.2 onwards a
newer launch shows a message explaining this.)
