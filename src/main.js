"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app, BrowserWindow, Menu, Notification, Tray, dialog, globalShortcut,
  nativeImage, screen, session, shell, webContents,
} = require("electron");
const { APP_ORIGIN, START_PATH, FULL_SITE_PATH, COMPANION_PATHS, classifyUrl, classifyForSite } = require("./navigation");
const { versionFooterScript, backButtonScript } = require("./inject");
const { createUpdater } = require("./updates");
const store = require("./settings");
// Read from our own package.json so it is right however the app is launched.
const PKG = require("../package.json");
const VERSION = PKG.version;
const PRODUCT_NAME = PKG.productName;

const PARTITION = "persist:stratus"; // one sign-in shared by every window of this app
const BACKGROUND = "#0b0f14";
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
  companionWindow.webContents.on("did-finish-load", () => { tidyCompanionPage(companionWindow); addBackButton(companionWindow); });
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
  wc.setWindowOpenHandler(({ url }) => { route(win, classify(url), url); return { action: "deny" }; });
  wc.on("will-navigate", (event, url) => {
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

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip(`Stratus OPs Companion ${VERSION}`);
    tray.on("click", toggleVisibility);
    rebuildTray();
  } catch {
    tray = null; // some locked-down systems have no tray; the app still works without it
  }
}

function rebuildTray() {
  if (!tray) return;
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
    ...updateMenuItems(),
    { label: `Version ${VERSION}`, enabled: false },
    { label: "Quit", click: () => { isQuitting = true; app.quit(); } },
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

function handleUpdateChange(st) {
  rebuildTray();
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
    companion: () => companionWindow, view: () => view, settingsFile: () => settingsFile,
    flush: () => { captureBounds(); flushSettings(); },
  };
}
