"use strict";
// Finds, downloads and checks a newer Stratus Link, then stages it. Nothing here touches a running
// tracker: the new file waits in a "pending" folder until Stratus Link is next stopped and started.
const nodeFs = require("node:fs");
const nodeCrypto = require("node:crypto");
const path = require("node:path");
const { once } = require("node:events");
const { isVersion, compareVersions } = require("./versions");

const MAX_BYTES = 200 * 1024 * 1024; // the same ceiling the website's release bucket used
const EXE_FILE = "StratusLink.exe";

/** Where files for a repo like "axiometra/StratusLink-Releases" are allowed to come from. */
const releasePrefix = (repo) => `https://github.com/${repo}/releases/download/`;
const manifestUrl = (repo) => `https://github.com/${repo}/releases/latest/download/tracker.json`;

/** Returns { ok: true, manifest } or { ok: false, error }. Nothing is trusted until it passes. */
function validateManifest(raw, { allowedPrefix }) {
  const fail = (error) => ({ ok: false, error });
  if (!raw || typeof raw !== "object") return fail("The update information was not readable.");
  const { version, sha256, size, url } = raw;
  if (!isVersion(version)) return fail("The update has an invalid version number.");
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256)) return fail("The update has no valid checksum.");
  if (!Number.isInteger(size) || size < 1024 || size > MAX_BYTES) return fail("The update has an invalid size.");
  if (typeof url !== "string" || !url.startsWith(allowedPrefix) || !url.endsWith(`/${EXE_FILE}`)) return fail("The update points somewhere that is not allowed.");
  let parsed;
  try { parsed = new URL(url); } catch { return fail("The update address is invalid."); }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) return fail("The update address is invalid.");
  return { ok: true, manifest: { version: version.trim(), sha256: sha256.toLowerCase(), size, url } };
}

function createTrackerFeed({
  repo,
  allowedPrefix = releasePrefix(repo),
  feedUrl = manifestUrl(repo),
  fetchImpl,                       // fetch-compatible function
  manager,                         // tracker manager (knows installed / pending / bundled versions)
  fs = nodeFs,
  crypto = nodeCrypto,
  tmpDir,                          // where partial downloads go
  onChange = () => {},
  timeouts = { manifestMs: 30000, downloadMs: 10 * 60 * 1000 },
}) {
  const state = { status: "idle", version: null, error: null, checkedAt: null };
  let busy = null;
  const set = (patch) => { Object.assign(state, patch); onChange({ ...state }); };

  const newestKnown = () => {
    const versions = [manager.installedInfo().version, manager.pendingInfo().version, manager.bundledVersion()].filter(Boolean);
    return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best), "0");
  };

  async function fetchManifest() {
    const res = await fetchImpl(feedUrl, { redirect: "follow", signal: AbortSignal.timeout(timeouts.manifestMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Could not check for a Stratus Link update (${res.status}).`);
    let raw;
    try { raw = JSON.parse(await res.text()); } catch { throw new Error("The update information was not readable."); }
    const checked = validateManifest(raw, { allowedPrefix });
    if (!checked.ok) throw new Error(checked.error);
    return checked.manifest;
  }

  async function download(manifest) {
    fs.mkdirSync(tmpDir, { recursive: true });
    const part = path.join(tmpDir, `StratusLink-${manifest.version}.exe.part`);
    const res = await fetchImpl(manifest.url, { redirect: "follow", signal: AbortSignal.timeout(timeouts.downloadMs) });
    if (!res.ok || !res.body) throw new Error(`The Stratus Link download failed (${res.status}).`);
    const hash = crypto.createHash("sha256");
    const out = fs.createWriteStream(part);
    let size = 0;
    let first = null;
    try {
      for await (const piece of res.body) {
        const chunk = Buffer.from(piece);
        if (first === null) first = chunk.subarray(0, 2).toString("latin1");
        size += chunk.length;
        if (size > manifest.size || size > MAX_BYTES) throw new Error("The Stratus Link download was larger than expected.");
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, "drain");
      }
      out.end();
      await once(out, "finish");
    } catch (err) {
      out.destroy();
      try { fs.unlinkSync(part); } catch { /* nothing to clean */ }
      throw err;
    }
    const problem =
      size !== manifest.size ? "The Stratus Link download was incomplete." :
      hash.digest("hex") !== manifest.sha256 ? "The Stratus Link download did not match its checksum, so it was discarded." :
      first !== "MZ" ? "The Stratus Link download is not a Windows program." : null;
    if (problem) { try { fs.unlinkSync(part); } catch { /* ignore */ } throw new Error(problem); }
    return part;
  }

  async function run() {
    set({ status: "checking", error: null });
    try {
      const manifest = await fetchManifest();
      if (compareVersions(manifest.version, newestKnown()) <= 0) {
        set({ status: "up-to-date", version: null, checkedAt: Date.now() });
        return { ...state };
      }
      set({ status: "downloading", version: manifest.version });
      const file = await download(manifest);
      manager.stagePending(file, manifest.version);
      set({ status: "ready", version: manifest.version, checkedAt: Date.now() });
    } catch (err) {
      set({ status: "error", error: String((err && err.message) || err).slice(0, 200), checkedAt: Date.now() });
    }
    return { ...state };
  }

  // One check at a time; a second call just waits for the first.
  function check() {
    if (!busy) busy = run().finally(() => { busy = null; });
    return busy;
  }

  return { check, state: () => ({ ...state }) };
}

module.exports = { createTrackerFeed, validateManifest, releasePrefix, manifestUrl, MAX_BYTES };
