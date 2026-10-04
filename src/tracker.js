"use strict";
// Starting, stopping and watching the bundled Stratus Link tracker (a Windows .exe).
// All operating-system access is passed in, so the logic can be unit tested anywhere.
const nodeFs = require("node:fs");
const nodeCrypto = require("node:crypto");
const path = require("node:path");
const { isVersion, compareVersions } = require("./versions");

const EXE_NAME = "StratusLink.exe";

/** Process ids of every StratusLink.exe in `tasklist /FO CSV /NH` output. (The packaged
 *  tracker shows up as two processes: a small launcher plus the program itself.) */
function parseTasklist(stdout) {
  const pids = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
    if (m && m[1].toLowerCase() === EXE_NAME.toLowerCase()) pids.push(Number(m[2]));
  }
  return pids;
}

function createTrackerManager({
  platform = process.platform,
  bundledExe,
  installDir,
  run,                      // async (command, args) => ({ stdout })
  spawn,                    // child_process.spawn
  fs = nodeFs,
  crypto = nodeCrypto,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onChange = () => {},
}) {
  const supported = platform === "win32";
  const installedExe = path.join(installDir, EXE_NAME);
  let pids = [];
  let bundled = false;
  let lastKey = null;
  let timer = null;

  const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

  function status() {
    const running = pids.length > 0;
    let state;
    if (!supported) state = "unsupported";
    else if (running) state = "running";
    else if (!bundled) state = "not-bundled";
    else state = "stopped";
    return { state, pids: [...pids] };
  }

  async function refresh() {
    if (supported) {
      try {
        const { stdout } = await run("tasklist", ["/FI", `IMAGENAME eq ${EXE_NAME}`, "/FO", "CSV", "/NH"]);
        pids = parseTasklist(stdout);
      } catch {
        pids = []; // could not ask Windows; assume not running rather than guess
      }
    }
    bundled = fs.existsSync(bundledExe) || fs.existsSync(installedExe) || fs.existsSync(pendingExe);
    const s = status();
    const key = `${s.state}:${s.pids.length}`;
    if (key !== lastKey) { lastKey = key; onChange(s); }
    return s;
  }

  function startPolling(intervalMs = 10000) {
    stopPolling();
    timer = setInterval(refresh, intervalMs);
    if (timer.unref) timer.unref();
  }
  function stopPolling() { if (timer) clearInterval(timer); timer = null; }

  // ---- versions: what is installed, what is waiting, what shipped inside this Companion ----
  const versionFile = path.join(installDir, "version.json");
  const pendingDir = path.join(installDir, "pending");
  const pendingExe = path.join(pendingDir, EXE_NAME);
  const pendingFile = path.join(pendingDir, "version.json");

  function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  function installedInfo() {
    const j = readJson(versionFile);
    const exists = fs.existsSync(installedExe);
    return { exists, version: exists && j && isVersion(j.version) ? j.version : null, source: exists && j ? j.source || null : null };
  }
  function pendingInfo() {
    const j = readJson(pendingFile);
    const exists = fs.existsSync(pendingExe);
    return { exists, version: exists && j && isVersion(j.version) ? j.version : null };
  }
  function bundledVersion() {
    try {
      const v = fs.readFileSync(path.join(path.dirname(bundledExe), "version.txt"), "utf8").trim();
      return isVersion(v) ? v : null;
    } catch { return null; }
  }
  const writeVersion = (version, source) => fs.writeFileSync(versionFile, JSON.stringify({ version: version || null, source, installedAt: new Date().toISOString() }));
  function clearPending() { try { fs.rmSync(pendingDir, { recursive: true, force: true }); } catch { /* ignore */ } }

  /** Move a downloaded, already-verified file into the pending folder (never touches the running tracker). */
  function stagePending(file, version) {
    clearPending();
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.renameSync(file, pendingExe);
    fs.writeFileSync(pendingFile, JSON.stringify({ version, stagedAt: new Date().toISOString() }));
  }

  // Runs the tracker from a per-user folder, not from the installed app folder, so that a running
  // tracker never blocks an app update from replacing files. Only ever called while it is not running.
  // Picks the newest of: the installed copy, a downloaded update, and the copy shipped with this Companion.
  function ensureInstalled() {
    fs.mkdirSync(installDir, { recursive: true });
    const bundledExists = fs.existsSync(bundledExe);
    const bundledV = bundledVersion();

    // 1. a downloaded update, if it is newer than what is installed
    const pend = pendingInfo();
    let inst = installedInfo();
    if (pend.exists) {
      if (pend.version && (!inst.exists || compareVersions(pend.version, inst.version) > 0)) {
        fs.renameSync(pendingExe, installedExe);
        writeVersion(pend.version, "update");
      }
      clearPending();
      inst = installedInfo();
    }

    // 2. the copy shipped inside this Companion, when nothing is installed or it is newer
    if (bundledExists) {
      const copyBundled = () => {
        const temp = `${installedExe}.new`;
        fs.copyFileSync(bundledExe, temp);
        fs.renameSync(temp, installedExe);
        writeVersion(bundledV, "bundled");
      };
      if (!inst.exists) copyBundled();
      else if (bundledV && compareVersions(bundledV, inst.version) > 0) copyBundled();
      else if (!bundledV && inst.source !== "update" && hash(installedExe) !== hash(bundledExe)) copyBundled(); // older builds without a version file
    }
    if (!fs.existsSync(installedExe)) throw new Error("No Stratus Link program is available to run.");
    return installedExe;
  }

  /** Apply a waiting update right now, but only if Stratus Link is not running. Returns true if anything changed. */
  async function applyPendingIfIdle() {
    await refresh();
    if (pids.length || !pendingInfo().exists) return false;
    const before = installedInfo().version;
    ensureInstalled();
    return installedInfo().version !== before;
  }

  /** The version to show: the installed one, else what would be installed. */
  function currentVersion() {
    return installedInfo().version || pendingInfo().version || bundledVersion();
  }

  async function start() {
    if (!supported) return { ok: false, error: "Stratus Link only runs on Windows." };
    await refresh();
    if (pids.length) return { ok: true, alreadyRunning: true };
    if (!fs.existsSync(bundledExe) && !installedInfo().exists && !pendingInfo().exists) return { ok: false, error: "This copy of the Companion does not include Stratus Link." };
    let exe;
    try { exe = ensureInstalled(); } catch (err) { return { ok: false, error: `Could not prepare Stratus Link: ${err.message}` }; }
    let spawnError = null;
    try {
      const child = spawn(exe, [], { detached: true, stdio: "ignore", cwd: installDir });
      child.on("error", (err) => { spawnError = err; });
      child.unref(); // keeps running independently of the Companion
    } catch (err) {
      return { ok: false, error: `Stratus Link could not start: ${err.message}` };
    }
    await sleep(1500);
    await refresh();
    if (spawnError) return { ok: false, error: `Stratus Link could not start: ${spawnError.message}` };
    if (!pids.length) return { ok: false, error: "Stratus Link closed straight away. Windows security software may have blocked it, so check its quarantine or protection history." };
    return { ok: true };
  }

  async function stop() {
    await refresh();
    if (!pids.length) return { ok: true };
    for (const pid of pids) await run("taskkill", ["/PID", String(pid), "/T"]).catch(() => {}); // polite close first
    for (let i = 0; i < 8; i++) { await sleep(500); await refresh(); if (!pids.length) return { ok: true }; }
    for (const pid of pids) await run("taskkill", ["/PID", String(pid), "/T", "/F"]).catch(() => {});
    await sleep(500);
    await refresh();
    return pids.length ? { ok: false, error: "Stratus Link would not close." } : { ok: true };
  }

  return {
    status, refresh, start, stop, startPolling, stopPolling, ensureInstalled, supported,
    installedInfo, pendingInfo, bundledVersion, stagePending, applyPendingIfIdle, currentVersion,
  };
}

module.exports = { createTrackerManager, parseTasklist, EXE_NAME };
