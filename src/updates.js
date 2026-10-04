"use strict";
// Automatic updates, kept separate from Electron so the logic can be unit tested.
// `autoUpdater` is electron-updater's updater (or a fake in tests).

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const message = (err) => String((err && err.message) || err || "Unknown error").split("\n")[0].slice(0, 200);

function createUpdater({ autoUpdater, enabled, onChange, intervalMs = FOUR_HOURS, firstCheckDelayMs = 15000, timers = { setTimeout, setInterval } }) {
  const state = { status: enabled ? "idle" : "disabled", version: null, percent: null, error: null };
  const set = (patch) => { Object.assign(state, patch); onChange({ ...state }); };

  if (enabled) {
    autoUpdater.autoDownload = true;          // fetch new versions quietly in the background
    autoUpdater.autoInstallOnAppQuit = true;  // and install them whenever the app is next quit
    autoUpdater.allowPrerelease = false;      // players only ever get published releases
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => set({ status: "checking", error: null }));
    autoUpdater.on("update-available", (info) => set({ status: "downloading", version: info.version, percent: 0 }));
    autoUpdater.on("update-not-available", () => set({ status: "up-to-date", version: null, percent: null }));
    autoUpdater.on("download-progress", (p) => set({ status: "downloading", percent: Math.round(p.percent) }));
    autoUpdater.on("update-downloaded", (info) => set({ status: "ready", version: info.version, percent: 100 }));
    autoUpdater.on("error", (err) => set({ status: "error", error: message(err) }));
  }

  async function check() {
    if (!enabled) return { ...state };
    // Never restart a download that is already finished or running.
    if (state.status === "ready" || state.status === "downloading") return { ...state };
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      set({ status: "error", error: message(err) });
    }
    return { ...state };
  }

  function start() {
    if (!enabled) return;
    timers.setTimeout(check, firstCheckDelayMs);
    timers.setInterval(check, intervalMs);
  }

  function installNow() {
    if (state.status !== "ready") return false;
    autoUpdater.quitAndInstall(true, true); // silent install, then reopen the app
    return true;
  }

  return { state: () => ({ ...state }), check, start, installNow };
}

module.exports = { createUpdater, FOUR_HOURS };
