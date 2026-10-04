"use strict";
const fs = require("node:fs");
const { execFile, spawn } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut,
  nativeImage, net, screen, session, shell, webContents,
} = require("electron");
const { APP_ORIGIN, START_PATH, FULL_SITE_PATH, COMPANION_PATHS, classifyUrl, classifyForSite } = require("./navigation");
const { versionFooterScript, backButtonScript } = require("./inject");
const { createUpdater } = require("./updates");
const { createTrackerManager } = require("./tracker");
const { createTrackerFeed } = require("./trackerUpdates");
const CONFIG = require("./config");
const store = require("./settings");
// Read from our own package.json so it is right however the app is launched.
const PKG = require("../package.json");
const VERSION = PKG.version;
const PRODUCT_NAME = PKG.productName;

const PARTITION = "persist:stratus"; // one sign-in shared by every window of this app
const BACKGROUND = "#0b0f14";
// The footer's "Update ready" link points here. The shell intercepts it; nothing is ever loaded.
const UPDATE_URL = "stratus-update://restart";
const ICON = path.join(__dirname, "..", "assets", "icon.png");
const OFFLINE_PAGE = path.join(__dirname, "offline.html");
const OFFLINE_PATHNAME = pathToFileURL(OFFLINE_PAGE).pathname;
// Global shortcut for Standard <-> Compact. A function key avoids stealing common
// shortcuts such as Ctrl+Shift+C (browser inspector). Change it here if needed.
const COMPACT_SHORTCUT = "CommandOrControl+Shift+F9";
const COMPACT_SHORTCUT_LABEL = "Ctrl+Shift+F9";
// The web page remembers its own layout under this key. The shell owns the layout
// instead (see tidyCompanionPage), so it is reset in Standard mode.
const PAGE_COMPACT_KEY = "stratus-companion-compact";

let companionWindow = null;
let tray = null;
let updater = null;
let tracker = null;
let trackerFeed = null;
let trackerNoticeVersion = null;
let notifiedVersion = null;
// The app has ONE window. It shows either the small Companion or the full site, and changes
// size to suit. "view" is which one it is showing right now.
let view = "companion";
let companionPlace = null; // where the small window was before it grew to show the site
let settings = null;
let settingsFile = null;
let isQuitting = false;
let saveTimer = null;

const alive = (w) => Boolean(w) && !w.isDestroyed();
const startUrl = (mode = settings.mode) => `${APP_ORIGIN}${START_PATH}${mode === "compact" ? "?compact=1" : ""}`;
const webPreferences = () => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, partition: PARTITION });

if (!app.requestSingleInstanceLock({ version: VERSION })) {
  app.quit(); // another copy is already running; it receives our version and brings itself forward
} else {
  app.setAppUserModelId("com.axiometra.stratuscompanion");
  app.on("second-instance", (_event, _argv, _cwd, extra) => {
    showCompanion();
    // Closing the window only hides it to the tray, so an OLD copy can keep running and swallow a
    // newly launched one. Say so, instead of silently showing the old version.
    const other = extra && typeof extra.version === "string" ? extra.version : null;
    if (other && other !== VERSION && alive(companionWindow)) {
      dialog.showMessageBox(companionWindow, {
        type: "info", buttons: ["OK"], title: "Already running",
        message: `Version ${VERSION} is already running.`,
        detail: `You just started version ${other}, but this copy was already open, so it was brought forward instead. To use version ${other}: right-click the tray icon, choose Quit, then start the app again.`,
      });
    }
  });
  app.on("before-quit", () => { isQuitting = true; captureBounds(); flushSettings(); });
  app.on("will-quit", () => globalShortcut.unregisterAll());
  app.on("window-all-closed", () => app.quit());
  // Defence in depth: no <webview> tags, ever.
  app.on("web-contents-created", (_e, contents) => {
    contents.on("will-attach-webview", (event) => event.preventDefault());
  });
  app.whenReady().then(start);
}

function start() {
  Menu.setApplicationMenu(null);
  settingsFile = path.join(app.getPath("userData"), "window-settings.json");
  settings = store.load(settingsFile);

  const ses = session.fromPartition(PARTITION);
  // The Companion needs no camera, microphone, location, etc.
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  // If the site itself has a server problem, show our retry page rather than a broken screen.
  ses.webRequest.onCompleted({ urls: [`${APP_ORIGIN}/*`] }, (details) => {
    if (details.resourceType !== "mainFrame" || details.statusCode < 500) return;
    const win = BrowserWindow.fromWebContents(webContents.fromId(details.webContentsId) || undefined);
    if (alive(win)) showError(win, "server", details.url);
  });

  createCompanionWindow();
  createTray();
  setupUpdates();
  setupTracker();
  try { globalShortcut.register(COMPACT_SHORTCUT, toggleCompact); } catch { /* tray menu still works */ }
}

/* ---------- settings ---------- */

function flushSettings() {
  clearTimeout(saveTimer);
  if (settingsFile && settings) store.save(settingsFile, settings);
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { captureBounds(); flushSettings(); }, 400);
}
function captureBounds() {
  if (!alive(companionWindow) || companionWindow.isMinimized() || companionWindow.isFullScreen()) return;
  const b = companionWindow.getNormalBounds();
  if (view === "site") {
    settings.sizes.site = { width: b.width, height: b.height }; // never overwrite the Companion's saved spot
  } else {
    settings.x = b.x;
    settings.y = b.y;
    settings.sizes[settings.mode] = { width: b.width, height: b.height };
  }
}

/* ---------- Companion window ---------- */

function createCompanionWindow() {
  const bounds = store.fitBounds(settings, screen.getAllDisplays().map((d) => d.workArea));
  companionWindow = new BrowserWindow({
    ...bounds,
    minWidth: store.MIN_SIZE.width,
    minHeight: store.MIN_SIZE.height,
    show: false,
    backgroundColor: BACKGROUND,
    title: "Stratus OPs Companion",
    icon: ICON,
    autoHideMenuBar: true,
    webPreferences: webPreferences(),
  });
  applyAlwaysOnTop();
  companionWindow.setOpacity(settings.opacity);

  companionWindow.once("ready-to-show", () => companionWindow.show());
  companionWindow.on("resize", scheduleSave);
  companionWindow.on("move", scheduleSave);
  companionWindow.on("close", (event) => {
    if (isQuitting || !tray) return; // no tray = no way back, so close really quits
    event.preventDefault();
    companionWindow.hide();
    rebuildTray();
    if (!settings.trayNoticeShown && Notification.isSupported()) {
      new Notification({ title: "Stratus OPs Companion", body: "Still running in the tray. Right-click the icon to show it again or quit." }).show();
      settings.trayNoticeShown = true;
      flushSettings();
    }
  });
  companionWindow.on("closed", () => { companionWindow = null; });

  wireNavigation(companionWindow, classifyUrl);
  wireKeys(companionWindow);
  companionWindow.webContents.on("did-finish-load", () => { tidyCompanionPage(companionWindow).then(pushUpdateState); addBackButton(companionWindow); });
  // Size the window to suit the page it is showing (Companion = small, anything else = big).
  companionWindow.webContents.on("did-navigate", (_e, url) => syncView(url));
  companionWindow.webContents.on("did-navigate-in-page", (_e, url, isMainFrame) => { if (isMainFrame) syncView(url); });
  loadCompanion();
}

function loadCompanion() {
  companionWindow.loadURL(startUrl());
}

function applyAlwaysOnTop() {
  if (!alive(companionWindow)) return;
  // A big always-on-top window would cover the simulator, so it only floats as the small Companion.
  if (settings.alwaysOnTop && view === "companion") companionWindow.setAlwaysOnTop(true, "screen-saver");
  else companionWindow.setAlwaysOnTop(false);
}

function showCompanion() {
  if (!alive(companionWindow)) return;
  if (companionWindow.isMinimized()) companionWindow.restore();
  companionWindow.show();
  companionWindow.focus();
  rebuildTray();
}

function toggleVisibility() {
  if (!alive(companionWindow)) return;
  if (companionWindow.isVisible()) { companionWindow.hide(); rebuildTray(); } else showCompanion();
}

// Move/resize the single window for a view, keeping it on the screen it is on.
function placeWindow(size, at) {
  const current = companionWindow.getBounds();
  const spot = at || current;
  const area = screen.getDisplayMatching(spot).workArea;
  const width = Math.min(size.width, area.width);
  const height = Math.min(size.height, area.height);
  const x = Math.min(Math.max(spot.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(spot.y, area.y), area.y + area.height - height);
  if (companionWindow.isMaximized()) companionWindow.unmaximize();
  companionWindow.setBounds({ x, y, width, height });
}

function enterSiteView() {
  if (view === "site" || !alive(companionWindow)) return;
  captureBounds();
  companionPlace = companionWindow.getNormalBounds();
  view = "site";
  companionWindow.setMinimumSize(800, 500);
  placeWindow(settings.sizes.site);
  applyAlwaysOnTop();
  rebuildTray();
}

function enterCompanionView() {
  if (view === "companion" || !alive(companionWindow)) return;
  captureBounds();
  view = "companion";
  companionWindow.setMinimumSize(store.MIN_SIZE.width, store.MIN_SIZE.height);
  placeWindow(settings.sizes[settings.mode], companionPlace || undefined);
  applyAlwaysOnTop();
  rebuildTray();
}

function syncView(url) {
  if (!url || url.startsWith("file:")) return; // our retry page keeps whatever size we have
  const kind = classifyUrl(url);
  if (kind === "internal") enterCompanionView();
  else if (kind === "site") enterSiteView();
}

function setMode(mode) {
  if (!alive(companionWindow)) return;
  if (view === "companion" && settings.mode === mode) return;
  if (view === "site") {
    settings.mode = mode;
    enterCompanionView(); // resizes back to the small window in the chosen layout
  } else {
    captureBounds();
    settings.mode = mode;
    placeWindow(settings.sizes[mode]); // same position, new size
  }
  scheduleSave();
  loadCompanion();
  rebuildTray();
}
function toggleCompact() { setMode(settings.mode === "compact" ? "standard" : "compact"); }

// The shell owns Standard/Compact (tray menu + shortcut), so the web page's own layout
// button is hidden, and a layout the page remembered earlier cannot fight the window size.
// This relies on the page's button label ("Switch to ... layout") and storage key; if the
// page changes, the worst case is the button reappearing.
// Gives every full-site page an on-screen "Back to Companion" button (see inject.js).
async function addBackButton(win) {
  if (!win.webContents.getURL().startsWith(APP_ORIGIN)) return;
  try { await win.webContents.executeJavaScript(backButtonScript(startUrl(), COMPANION_PATHS)); } catch { /* page navigated away mid-way */ }
}

async function tidyCompanionPage(win) {
  const url = win.webContents.getURL();
  if (!url.startsWith(`${APP_ORIGIN}${START_PATH}`) && !url.startsWith(`${APP_ORIGIN}/auth`)) return;
  try {
    await win.webContents.insertCSS('button[aria-label^="Switch to"][aria-label$="layout"]{display:none !important;}');
    await win.webContents.executeJavaScript(versionFooterScript(VERSION));
    if (settings.mode === "standard" && url.startsWith(`${APP_ORIGIN}${START_PATH}`)) {
      const wasCompact = await win.webContents.executeJavaScript(
        `(() => { try { if (localStorage.getItem(${JSON.stringify(PAGE_COMPACT_KEY)}) === "1") { localStorage.setItem(${JSON.stringify(PAGE_COMPACT_KEY)}, "0"); return true; } } catch (e) {} return false; })()`
      );
      if (wasCompact) win.webContents.reload();
    }
  } catch { /* page navigated away mid-way; harmless */ }
}

/* ---------- Full site (same window, same sign-in) ---------- */

function openSite(url = `${APP_ORIGIN}${FULL_SITE_PATH}`) {
  if (!alive(companionWindow) || classifyForSite(url) !== "internal") return;
  showCompanion();
  enterSiteView(); // grow first so the page never loads into a tiny window
  companionWindow.loadURL(url);
}

function backToCompanion() {
  if (!alive(companionWindow)) return;
  showCompanion();
  enterCompanionView();
  loadCompanion();
}

/* ---------- shared window behaviour ---------- */

function isOfflinePage(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.protocol === "file:" && u.pathname === OFFLINE_PATHNAME;
  } catch { return false; }
}

function route(win, decision, url) {
  if (decision === "external") shell.openExternal(url);
  else if (decision === "site") openSite(url);
  else if (decision === "internal") { enterCompanionView(); win.loadURL(url); }
}

function wireNavigation(win, classify) {
  // One window: every page of the Stratus OPs site stays inside it; other websites go to the browser.
  const wc = win.webContents;
  // "Open in new tab" links never create stray app windows.
  wc.setWindowOpenHandler(({ url }) => {
    if (url === UPDATE_URL) restartToUpdate();
    else route(win, classify(url), url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (event, url) => {
    if (url === UPDATE_URL) { event.preventDefault(); restartToUpdate(); return; }
    if (isOfflinePage(url)) return; // our own retry page, and nothing else on disk
    const decision = classify(url);
    if (decision === "internal" || decision === "site") return; // stays in this window; the size follows the page
    event.preventDefault();
    route(win, decision, url);
  });
  // Site unreachable: friendly retry page instead of a blank window.
  wc.on("did-fail-load", (_e, code, _desc, failedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = navigation aborted, not a failure
    showError(win, "offline", failedUrl);
  });
}

function showError(win, reason, target) {
  if (!alive(win)) return;
  const safeTarget = classifyForSite(target) === "internal" ? target : startUrl();
  win.loadFile(OFFLINE_PAGE, { query: { reason, target: safeTarget } });
}

function reloadWindow(win) {
  const wc = win.webContents;
  const url = wc.getURL();
  if (isOfflinePage(url)) {
    const target = new URL(url).searchParams.get("target");
    if (target && classifyForSite(target) === "internal") { wc.loadURL(target); return; }
  }
  wc.reload();
}

// No menu bar, so give the usual keys: F5 / Ctrl+R reload, Alt+Left goes back.
function wireKeys(win) {
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F5" || (input.control && !input.alt && !input.shift && input.key.toLowerCase() === "r")) {
      event.preventDefault();
      reloadWindow(win);
    } else if (input.alt && input.key === "ArrowLeft" && win.webContents.navigationHistory.canGoBack()) {
      event.preventDefault();
      win.webContents.navigationHistory.goBack();
    }
  });
}

/* ---------- tray ---------- */

// Tray icons are pre-drawn at 16/24/32/48 px (100%/150%/200%/300% display scaling) so they stay sharp;
// "update" adds a small orange dot, like the Windows Update tray badge.
const TRAY_SIZES = [[1, 16], [1.5, 24], [2, 32], [3, 48]];
const trayImageCache = {};
function trayImage(withDot) {
  const key = withDot ? "update" : "plain";
  if (trayImageCache[key]) return trayImageCache[key];
  let image;
  try {
    image = nativeImage.createEmpty();
    for (const [scaleFactor, px] of TRAY_SIZES) {
      const file = path.join(__dirname, "..", "assets", `${withDot ? "tray-update" : "tray"}-${px}.png`);
      image.addRepresentation({ scaleFactor, width: px, height: px, dataURL: `data:image/png;base64,${fs.readFileSync(file).toString("base64")}` });
    }
    if (image.isEmpty()) throw new Error("empty tray image");
  } catch {
    image = nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }); // fallback: no dot, still works
  }
  trayImageCache[key] = image;
  return image;
}

function createTray() {
  try {
    tray = new Tray(trayImage(false));
    tray.setToolTip(`Stratus OPs Companion ${VERSION}`);
    tray.on("click", toggleVisibility);
    rebuildTray();
  } catch {
    tray = null; // some locked-down systems have no tray; the app still works without it
  }
}

function rebuildTray() {
  if (!tray) return;
  const up = updater ? updater.state() : null;
  tray.setImage(trayImage(Boolean(up && up.status === "ready"))); // orange dot while an update waits
  tray.setToolTip(up && up.status === "ready"
    ? `Stratus OPs Companion ${VERSION} - update ${up.version} ready, right-click to restart`
    : `Stratus OPs Companion ${VERSION}`);
  const visible = alive(companionWindow) && companionWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: visible ? "Hide Companion" : "Show Companion", click: toggleVisibility },
    { type: "separator" },
    {
      label: "Always on top", type: "checkbox", checked: settings.alwaysOnTop,
      click: (item) => { settings.alwaysOnTop = item.checked; applyAlwaysOnTop(); flushSettings(); },
    },
    {
      label: `Compact mode  (${COMPACT_SHORTCUT_LABEL})`, type: "checkbox", checked: settings.mode === "compact",
      click: (item) => setMode(item.checked ? "compact" : "standard"),
    },
    {
      label: "Opacity",
      submenu: store.OPACITY_CHOICES.map((value) => ({
        label: `${Math.round(value * 100)}%`, type: "radio", checked: settings.opacity === value,
        click: () => { settings.opacity = value; if (alive(companionWindow)) companionWindow.setOpacity(value); flushSettings(); },
      })),
    },
    { type: "separator" },
    ...(view === "site" ? [{ label: "Back to Companion", click: backToCompanion }] : [{ label: "Open full site", click: () => openSite() }]),
    { label: "Open in my browser", click: () => shell.openExternal(`${APP_ORIGIN}${FULL_SITE_PATH}`) },
    { type: "separator" },
    { label: "Sign out / switch account…", click: () => signOut() },
    { type: "separator" },
    ...trackerMenuItems(),
    { type: "separator" },
    ...updateMenuItems(),
    { label: `Version ${VERSION}`, enabled: false },
    { label: "Quit", click: quitFromTray },
  ]));
}

/* ---------- automatic updates ---------- */

// Updates only run for a copy that was put there by the installer. The plain zip and
// development runs have no uninstaller / update feed, so they quietly skip updating.
function setupUpdates() {
  const installed = app.isPackaged && process.env.STRATUS_TEST !== "1" &&
    fs.existsSync(path.join(path.dirname(process.execPath), `Uninstall ${PRODUCT_NAME}.exe`)) &&
    fs.existsSync(path.join(process.resourcesPath, "app-update.yml"));
  let autoUpdater = null;
  if (installed) {
    try { ({ autoUpdater } = require("electron-updater")); } catch { autoUpdater = null; }
  }
  updater = createUpdater({
    autoUpdater: autoUpdater || { on() {} },
    enabled: Boolean(autoUpdater),
    onChange: handleUpdateChange,
  });
  updater.start();
  rebuildTray();
}

// Tells the Companion page (its footer) whether a downloaded update is waiting for a restart.
function pushUpdateState() {
  if (!alive(companionWindow)) return;
  const st = updater ? updater.state() : { status: "disabled" };
  const version = st.status === "ready" ? st.version : null;
  const url = companionWindow.webContents.getURL();
  if (!url.startsWith(`${APP_ORIGIN}${START_PATH}`)) return;
  companionWindow.webContents.executeJavaScript(
    `window.__stratusUpdateVersion = ${JSON.stringify(version)}; window.dispatchEvent(new Event("stratus-shell-update"));`
  ).catch(() => {});
}

function handleUpdateChange(st) {
  rebuildTray();
  pushUpdateState();
  if (st.status === "ready" && st.version !== notifiedVersion && Notification.isSupported()) {
    notifiedVersion = st.version;
    const n = new Notification({
      title: "Stratus OPs Companion update ready",
      body: `Version ${st.version} is ready. Click here to restart and update, or it installs next time you quit.`,
    });
    n.on("click", restartToUpdate);
    n.show();
  }
}

function restartToUpdate() {
  isQuitting = true; // let the window really close instead of hiding to the tray
  if (!updater || !updater.installNow()) isQuitting = false;
}

async function checkForUpdatesNow() {
  if (!updater) return;
  const st = await updater.check();
  const parent = alive(companionWindow) && companionWindow.isVisible() ? companionWindow : undefined;
  let message = "You're up to date";
  let detail = `Version ${VERSION} is the latest.`;
  if (st.status === "downloading") { message = "Update found"; detail = `Version ${st.version} is downloading in the background. You will be notified when it is ready.`; }
  else if (st.status === "ready") { message = "Update ready"; detail = `Version ${st.version} is ready. Right-click the tray icon and choose "Restart to update".`; }
  else if (st.status === "error") { message = "Couldn't check for updates"; detail = `${st.error || "Unknown error"}\n\nCheck your internet connection and try again.`; }
  dialog.showMessageBox(parent, { type: st.status === "error" ? "warning" : "info", buttons: ["OK"], title: "Updates", message, detail });
}

function updateMenuItems() {
  const st = updater ? updater.state() : { status: "disabled" };
  switch (st.status) {
    case "disabled": return [{ label: "Updates: installed copies only", enabled: false }];
    case "ready": return [{ label: `Restart to update to ${st.version}`, click: restartToUpdate }];
    case "downloading": return [{ label: `Downloading update${st.percent != null ? ` (${st.percent}%)` : ""}…`, enabled: false }];
    case "checking": return [{ label: "Checking for updates…", enabled: false }];
    default: return [{ label: "Check for updates…", click: checkForUpdatesNow }];
  }
}

/* ---------- bundled Stratus Link tracker ---------- */

function setupTracker() {
  const localData = process.env.LOCALAPPDATA || app.getPath("appData");
  tracker = createTrackerManager({
    bundledExe: app.isPackaged
      ? path.join(process.resourcesPath, "stratus-link", "StratusLink.exe")
      : path.join(__dirname, "..", "bundled", "StratusLink.exe"),
    installDir: path.join(localData, PRODUCT_NAME, "stratus-link"), // per-user, outside the app folder
    run: (command, args) => promisify(execFile)(command, args, { windowsHide: true }),
    spawn,
    onChange: rebuildTray,
  });
  tracker.refresh().then(async (st) => {
    if (settings.startTracker && st.state === "stopped") await startTracker();
  });
  tracker.startPolling();

  // Newer Stratus Link versions are published on GitHub and fetched quietly in the background.
  if (tracker.supported && process.env.STRATUS_TEST !== "1") {
    trackerFeed = createTrackerFeed({
      repo: CONFIG.trackerRepo,
      fetchImpl: (url, options) => net.fetch(url, options), // Chromium's network stack: honours the system proxy
      manager: tracker,
      tmpDir: path.join(localData, PRODUCT_NAME, "stratus-link", "downloads"),
      onChange: () => rebuildTray(),
    });
    setTimeout(trackerUpdateTick, 30 * 1000);
    const timer = setInterval(trackerUpdateTick, 6 * 60 * 60 * 1000);
    if (timer.unref) timer.unref();
  }
}

// Check for a new Stratus Link; if it is downloaded and Stratus Link is not running, switch to it now.
// If it is running, the update waits (a flight is never interrupted) and the player is told once.
async function trackerUpdateTick({ notify = true } = {}) {
  if (!trackerFeed || !tracker) return null;
  const st = await trackerFeed.check();
  let applied = false;
  try { applied = await tracker.applyPendingIfIdle(); } catch { /* retried on the next start or check */ }
  rebuildTray();
  const waiting = tracker.pendingInfo();
  if (notify && waiting.exists && waiting.version && waiting.version !== trackerNoticeVersion && Notification.isSupported()) {
    trackerNoticeVersion = waiting.version;
    new Notification({
      title: "Stratus Link update downloaded",
      body: `Version ${waiting.version} will be used the next time Stratus Link starts. Right-click the Companion tray icon to restart it now.`,
    }).show();
  }
  return { state: st, applied };
}

async function checkTrackerNow() {
  const result = await trackerUpdateTick({ notify: false });
  if (!result) return;
  const { state, applied } = result;
  const waiting = tracker.pendingInfo();
  let message = "Stratus Link is up to date";
  let detail = `Version ${tracker.currentVersion() || "unknown"} is the latest.`;
  if (state.status === "error") { message = "Couldn't check for a Stratus Link update"; detail = `${state.error || "Unknown error"}\n\nCheck your internet connection and try again.`; }
  else if (applied) { message = "Stratus Link updated"; detail = `Now on version ${tracker.currentVersion()}. It will be used when you start Stratus Link.`; }
  else if (waiting.exists) { message = "Stratus Link update downloaded"; detail = `Version ${waiting.version} will be used the next time Stratus Link starts. Right-click the tray icon and choose "Restart Stratus Link to update" to switch now.`; }
  dialog.showMessageBox(dialogParent(), { type: state.status === "error" ? "warning" : "info", buttons: ["OK"], title: "Stratus Link", message, detail });
}

async function restartTrackerForUpdate() {
  if (!tracker) return;
  const { response } = await dialog.showMessageBox(dialogParent(), {
    type: "question", buttons: ["Restart Stratus Link", "Cancel"], defaultId: 1, cancelId: 1, title: "Stratus Link",
    message: "Restart Stratus Link to update it?",
    detail: "If you are in the middle of a flight, tracking pauses until you press Start tracking in the new window.",
  });
  if (response !== 0) return;
  const stopped = await tracker.stop();
  if (!stopped.ok) { showTrackerError(stopped.error); return; }
  await tracker.applyPendingIfIdle().catch(() => {});
  await startTracker();
}

function dialogParent() {
  return alive(companionWindow) && companionWindow.isVisible() ? companionWindow : undefined;
}

function showTrackerError(error) {
  dialog.showMessageBox(dialogParent(), {
    type: "warning", buttons: ["OK"], title: "Stratus Link",
    message: "Stratus Link couldn't start", detail: error || "Unknown error",
  });
}

async function startTracker() {
  if (!tracker) return;
  const result = await tracker.start();
  if (!result.ok) showTrackerError(result.error);
  rebuildTray();
}

async function stopTracker() {
  if (!tracker) return;
  const { response } = await dialog.showMessageBox(dialogParent(), {
    type: "question", buttons: ["Stop Stratus Link", "Cancel"], defaultId: 1, cancelId: 1, title: "Stratus Link",
    message: "Stop Stratus Link?",
    detail: "If you are in the middle of a flight, tracking pauses until you start Stratus Link again and press Start tracking.",
  });
  if (response !== 0) return;
  const result = await tracker.stop();
  if (!result.ok) dialog.showMessageBox(dialogParent(), { type: "warning", buttons: ["OK"], title: "Stratus Link", message: result.error });
  rebuildTray();
}

function trackerMenuItems() {
  const st = tracker ? tracker.status() : { state: "unsupported" };
  const labels = { running: "running", stopped: "stopped", "not-bundled": "not included in this copy", unsupported: "Windows only" };
  const current = tracker && (st.state === "running" || st.state === "stopped") ? tracker.currentVersion() : null;
  const items = [{ label: `Stratus Link: ${labels[st.state]}${current ? ` (${current})` : ""}`, enabled: false }];
  const feed = trackerFeed ? trackerFeed.state() : null;
  const waiting = tracker && tracker.supported ? tracker.pendingInfo() : { exists: false };
  if (feed && (feed.status === "checking" || feed.status === "downloading") && !waiting.exists) {
    items.push({ label: feed.status === "downloading" ? `Downloading Stratus Link ${feed.version || ""}…` : "Checking for a Stratus Link update…", enabled: false });
  } else if (waiting.exists && st.state === "running") {
    items.push({ label: `Restart Stratus Link to update to ${waiting.version}…`, click: restartTrackerForUpdate });
  } else if (feed) {
    items.push({ label: "Check for Stratus Link updates…", click: checkTrackerNow });
  }
  if (st.state === "stopped") items.push({ label: "Start Stratus Link", click: startTracker });
  if (st.state === "running") items.push({ label: "Stop Stratus Link…", click: stopTracker });
  if (st.state === "stopped" || st.state === "running") {
    items.push({
      label: "Start Stratus Link with Companion", type: "checkbox", checked: settings.startTracker,
      click: (item) => { settings.startTracker = item.checked; flushSettings(); },
    });
    items.push({ label: "Get my tracker token…", click: () => openSite(`${APP_ORIGIN}/connections`) });
  }
  return items;
}

// Quitting the Companion must not silently end a flight's tracking, so ask while Stratus Link runs.
async function quitFromTray() {
  if (tracker && tracker.status().state === "running") {
    const { response } = await dialog.showMessageBox(dialogParent(), {
      type: "question", buttons: ["Quit Companion only", "Quit both", "Cancel"], defaultId: 0, cancelId: 2, title: "Quit",
      message: "Stratus Link is still running.",
      detail: "\"Quit Companion only\" keeps tracking your flight. \"Quit both\" also stops Stratus Link; if you are mid-flight, tracking pauses until you start it again.",
    });
    if (response === 2) return;
    if (response === 1) {
      const result = await tracker.stop();
      if (!result.ok) { showTrackerError(result.error); return; }
    }
  }
  isQuitting = true;
  app.quit();
}

/* ---------- sign out ---------- */

async function signOut({ confirm = true } = {}) {
  showCompanion();
  if (confirm) {
    const { response } = await dialog.showMessageBox(alive(companionWindow) ? companionWindow : undefined, {
      type: "question", buttons: ["Sign out", "Cancel"], defaultId: 1, cancelId: 1,
      title: "Sign out", message: "Sign out of Stratus OPs Companion?",
      detail: "You will need to sign in again.",
    });
    if (response !== 0) return;
  }
  const ses = session.fromPartition(PARTITION);
  await ses.clearStorageData(); // cookies, local storage and IndexedDB: where the site keeps its sign-in
  await ses.clearCache();
  if (alive(companionWindow)) backToCompanion();
}

// Test hook only; has no effect for players.
if (process.env.STRATUS_TEST === "1") {
  global.__stratus = {
    settings: () => settings, setMode, toggleCompact, openSite, signOut, backToCompanion,
    companion: () => companionWindow, view: () => view, settingsFile: () => settingsFile, tracker: () => tracker,
    flush: () => { captureBounds(); flushSettings(); },
    trayImages: () => {
      const sample = (img, x, y) => { const b = img.toBitmap({ scaleFactor: 2 }); const i = (y * 32 + x) * 4; return { r: b[i + 2], g: b[i + 1], b: b[i] }; };
      const plain = trayImage(false), dot = trayImage(true);
      return { logical: plain.getSize(1), plainPixels2x: plain.toBitmap({ scaleFactor: 2 }).length / 4, dotPixels2x: dot.toBitmap({ scaleFactor: 2 }).length / 4,
        plainEmpty: plain.isEmpty(), dotEmpty: dot.isEmpty(),
        plainCorner: sample(plain, 26, 26), dotCorner: sample(dot, 26, 26) };
    },
    fakeUpdate: (version) => {
      const { EventEmitter } = require("node:events");
      const fake = new EventEmitter();
      fake.calls = [];
      fake.quitAndInstall = (...args) => fake.calls.push(args);
      updater = createUpdater({ autoUpdater: fake, enabled: true, onChange: handleUpdateChange, timers: { setTimeout() {}, setInterval() {} } });
      fake.emit("update-downloaded", { version });
      return fake;
    },
  };
}
