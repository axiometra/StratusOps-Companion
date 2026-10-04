"use strict";
// End-to-end smoke test against a fake local "Stratus OPs" server.
// Run with:  xvfb-run -a npx electron --no-sandbox --user-data-dir=/tmp/stratus-smoke scripts/smoke.js
// (On Windows/Mac omit xvfb-run and --no-sandbox.) Phase 2 re-launches to prove settings persist.
const http = require("node:http");
const fs = require("node:fs");
const PORT = 8765;
process.env.STRATUS_ORIGIN = `http://127.0.0.1:${PORT}`;
process.env.STRATUS_TEST = "1";
const PHASE = process.env.SMOKE_PHASE || "1";

const electron = require("electron");
const opened = [];
electron.shell.openExternal = (url) => { opened.push(url); return Promise.resolve(); };

let failMode = false;
const page = (title, body = "") => `<!doctype html><title>${title}</title><body style="background:#111;color:#eee">${body}
<script>document.title = ${JSON.stringify(title)};</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (failMode && url.pathname === "/companion") { res.writeHead(500); return res.end("boom"); }
  res.setHeader("content-type", "text/html");
  if (url.pathname === "/companion") {
    res.end(page("companion " + (url.searchParams.get("compact") === "1" ? "compact" : "standard"),
      `<button aria-label="Switch to compact layout" id="toggle">layout</button>
       <a id="full" href="/dashboard" target="_blank" rel="noopener noreferrer" style="display:block;padding:20px">full</a>
       <a id="ext" href="https://example.com/x" target="_blank" rel="noopener noreferrer" style="display:block;padding:20px">ext</a>
       <button id="spa" onclick="history.pushState({}, '', '/dashboard')">spa</button>
       <footer id="foot" style="display:flex;justify-content:space-between"><span>Updated just now</span><a href="/dashboard" target="_blank">Open full site</a></footer>`));
  } else if (url.pathname === "/dashboard") res.end(page("dashboard"));
  else res.end(page("other"));
});

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  [" + extra + "]" : ""}`); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; }
const ev = (w, code) => w.webContents.executeJavaScript(code);
// A real mouse click (with user gesture), like a player clicking the link.
async function realClick(w, selector) {
  const r = await ev(w, `(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  w.webContents.sendInputEvent({ type: "mouseMove", x: r.x, y: r.y });
  w.webContents.sendInputEvent({ type: "mouseDown", x: r.x, y: r.y, button: "left", clickCount: 1 });
  w.webContents.sendInputEvent({ type: "mouseUp", x: r.x, y: r.y, button: "left", clickCount: 1 });
}

server.listen(PORT, "127.0.0.1", async () => {
  require("../src/main.js");
  await electron.app.whenReady();
  await wait(500);
  const S = global.__stratus;
  const finish = () => { const bad = results.filter((r) => !r).length; console.log(bad ? `\n${bad} FAILED` : "\nALL PASSED"); electron.app.exit(bad ? 1 : 0); };

  const c = () => S.companion();
  if (PHASE === "2") {
    await waitFor(() => c() && c().webContents.getURL().includes("/companion"));
    check("relaunch restores compact mode", S.settings().mode === "compact" && c().webContents.getURL().includes("compact=1"), c().webContents.getURL());
    const [w, h] = c().getSize();
    check("relaunch restores remembered compact size", w === 460 && h === 190, `${w}x${h}`);
    check("relaunch restores always-on-top = off and opacity 85%", !c().isAlwaysOnTop() && Math.abs(c().getOpacity() - 0.85) < 0.01, `top=${c().isAlwaysOnTop()} opacity=${c().getOpacity()}`);
    return finish();
  }

  await waitFor(() => c() && c().webContents.getTitle() === "companion standard");
  check("opens Companion in standard layout", c().webContents.getTitle() === "companion standard", c().webContents.getTitle());
  check("always on top by default", c().isAlwaysOnTop() === true);
  const footerText = () => ev(c(), `Array.from(document.querySelectorAll('#foot > *')).map(e => e.textContent).join(' | ')`);
  const pkgVersion = require("../package.json").version;
  check("footer shows the app version between the update time and the link", (await footerText()) === `Updated just now | App v${pkgVersion} | Open full site`, await footerText());
  await ev(c(), `document.getElementById('foot').innerHTML = '<span>Updated 5s ago</span><a href="/dashboard">Open full site</a>'`);
  await wait(300);
  check("footer version is re-added if the page redraws its footer", (await footerText()) === `Updated 5s ago | App v${pkgVersion} | Open full site`, await footerText());
  check("page layout button is hidden by the shell", (await ev(c(), `getComputedStyle(document.getElementById('toggle')).display`)) === "none");

  // Stale page-remembered layout must be reset in standard mode.
  await ev(c(), `localStorage.setItem('stratus-companion-compact','1')`);
  c().webContents.reload();
  await waitFor(async () => (await ev(c(), `localStorage.getItem('stratus-companion-compact')`)) === "0");
  check("stale remembered layout is reset in standard mode", (await ev(c(), `localStorage.getItem('stratus-companion-compact')`)) === "0");

  // ONE window: "Open full site" grows the same window to the full site, same sign-in, no browser.
  const smallPlace = c().getBounds();
  await ev(c(), `localStorage.setItem('probe','signed-in-token')`);
  await realClick(c(), '#full');
  await waitFor(() => c().webContents.getURL().endsWith("/dashboard"));
  await wait(400);
  check("Open full site loads the site in the SAME window", c().webContents.getURL().endsWith("/dashboard") && electron.BrowserWindow.getAllWindows().length === 1, `${electron.BrowserWindow.getAllWindows().length} window(s)`);
  check("window grows to the full-site size", c().getSize()[0] >= 800 && c().getSize()[1] >= 500, c().getSize().join("x"));
  check("window stops floating on top while showing the full site", c().isAlwaysOnTop() === false);
  check("the sign-in is shared (same session)", (await ev(c(), `localStorage.getItem('probe')`)) === "signed-in-token");
  check("Open full site did not go to the browser", opened.length === 0, opened.join(","));

  // Back (Alt+Left / history) returns to the small Companion, in its old place.
  c().webContents.navigationHistory.goBack();
  await waitFor(() => c().webContents.getTitle() === "companion standard");
  await wait(400);
  const back = c().getBounds();
  check("going back returns to the small Companion size", back.width === 420 && back.height === 680, `${back.width}x${back.height}`);
  check("...in the same place on screen", back.x === smallPlace.x && back.y === smallPlace.y, `${back.x},${back.y} vs ${smallPlace.x},${smallPlace.y}`);
  check("...and floats on top again", c().isAlwaysOnTop() === true);

  // On-screen Back to Companion button on the full-site view.
  const hostExists = () => ev(c(), `Boolean(document.getElementById('stratus-back-to-companion'))`);
  check("no Back button on the small Companion page", !(await hostExists()));
  S.openSite();
  await waitFor(async () => S.view() === "site" && c().webContents.getURL().endsWith("/dashboard") && (await hostExists()));
  check("a Back to Companion button appears on the full-site page", await hostExists());
  await realClick(c(), "#stratus-back-to-companion");
  await waitFor(() => c().webContents.getTitle() === "companion standard");
  await wait(400);
  check("clicking the button returns to the small Companion, same place", S.view() === "companion" && c().getSize().join("x") === "420x680" && c().getBounds().x === smallPlace.x, `${c().getSize().join("x")} @ ${c().getBounds().x}`);
  S.toggleCompact();
  await waitFor(() => c().webContents.getTitle() === "companion compact");
  S.openSite();
  await waitFor(async () => S.view() === "site" && (await hostExists()));
  await realClick(c(), "#stratus-back-to-companion");
  await waitFor(() => c().webContents.getTitle() === "companion compact");
  await wait(400);
  check("from compact mode the button returns to the compact window", S.view() === "companion" && c().getSize().join("x") === "420x160", c().getSize().join("x"));
  S.toggleCompact();
  await waitFor(() => c().webContents.getTitle() === "companion standard");

  // Other domains go to the default browser.
  await realClick(c(), '#ext');
  await wait(300);
  check("other websites open in the default browser", opened.includes("https://example.com/x"), opened.join(","));
  check("no extra windows from an external link", electron.BrowserWindow.getAllWindows().length === 1 && c().getSize()[0] === 420);

  // Single-page-app navigation (no full page load) also switches to the big view and back.
  await ev(c(), `document.getElementById('spa').click()`);
  await waitFor(() => c().webContents.getURL().endsWith("/dashboard") && c().getSize()[0] >= 800);
  check("in-page navigation to the site also grows the window", S.view() === "site" && c().getSize()[0] >= 800, c().getSize().join("x"));
  check("...and the Back button appears there too", await waitFor(hostExists, 4000));
  await S.backToCompanion();
  await waitFor(() => c().webContents.getTitle() === "companion standard");
  await wait(300);
  check("Back to Companion restores the small window", S.view() === "companion" && c().getSize()[0] === 420 && c().getBounds().x === smallPlace.x);

  // Layout toggle while the site is showing returns to the small Companion in that layout.
  S.openSite();
  await waitFor(() => S.view() === "site" && c().webContents.getURL().endsWith("/dashboard"));
  S.toggleCompact();
  await waitFor(() => c().webContents.getTitle() === "companion compact");
  await wait(300);
  check("compact shortcut from the site returns to the small compact window", S.view() === "companion" && c().getSize().join("x") === "420x160", c().getSize().join("x"));
  S.toggleCompact();
  await waitFor(() => c().webContents.getTitle() === "companion standard");

  // Compact mode.
  const before = c().getBounds();
  S.toggleCompact();
  await waitFor(() => c().webContents.getTitle() === "companion compact");
  const compact = c().getBounds();
  check("compact mode loads ?compact=1", c().webContents.getTitle() === "companion compact", c().webContents.getURL());
  check("compact mode resizes to the compact size, same position", compact.height === 160 && compact.width === 420 && compact.x === before.x, JSON.stringify(compact));
  c().setSize(460, 190); await wait(700);   // player resizes the compact window; remembered separately
  S.toggleCompact();
  await waitFor(() => c().webContents.getTitle() === "companion standard");
  check("standard size is remembered separately", c().getSize()[1] === 680, c().getSize().join("x"));

  // F5 reload key.
  let reloaded = false;
  c().webContents.once("did-start-loading", () => { reloaded = true; });
  c().webContents.sendInputEvent({ type: "keyDown", keyCode: "F5" });
  await wait(600);
  check("F5 reloads the page", reloaded);

  // Server error -> friendly retry page; F5/retry returns when fixed.
  failMode = true;
  c().webContents.reload();
  await waitFor(() => c().webContents.getURL().includes("offline.html"));
  check("a 500 from the site shows the retry page", c().webContents.getURL().includes("offline.html") && c().webContents.getURL().includes("reason=server"), c().webContents.getURL().slice(-60));
  failMode = false;
  c().webContents.sendInputEvent({ type: "keyDown", keyCode: "F5" });
  await waitFor(() => c().webContents.getTitle() === "companion standard");
  check("F5 on the retry page returns to the Companion once the site is back", c().webContents.getTitle() === "companion standard");

  // A page on the site may not send the app to arbitrary local files.
  c().webContents.executeJavaScript(`location.href = 'file:///etc/hostname'`).catch(() => {});
  await wait(600);
  check("pages cannot navigate the window to local files", !c().webContents.getURL().startsWith("file:"), c().webContents.getURL());

  // Sign out (even from the big site view) clears the session and returns to the small Companion.
  await ev(c(), `localStorage.setItem('probe','still-here')`);
  S.openSite();
  await waitFor(() => S.view() === "site");
  await S.signOut({ confirm: false });
  await waitFor(() => c().webContents.getTitle() === "companion standard");
  check("sign out leaves one small Companion window", electron.BrowserWindow.getAllWindows().length === 1 && S.view() === "companion");
  check("sign out clears stored sign-in data", (await ev(c(), `localStorage.getItem('probe')`)) === null);

  // Prepare phase 2: compact mode, remembered size, always-on-top off, 85% opacity.
  S.settings().alwaysOnTop = false; c().setAlwaysOnTop(false);
  S.settings().opacity = 0.85; c().setOpacity(0.85);
  S.toggleCompact();
  await waitFor(() => c().webContents.getTitle() === "companion compact");
  check("compact size remembered from earlier resize", c().getSize().join("x") === "460x190", c().getSize().join("x"));
  S.flush();
  const saved = JSON.parse(fs.readFileSync(S.settingsFile(), "utf8"));
  check("settings file written", saved.mode === "compact" && saved.sizes.compact.width === 460 && saved.opacity === 0.85 && saved.alwaysOnTop === false, JSON.stringify(saved));
  finish();
});
