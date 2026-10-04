"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createTrackerManager } = require("../src/tracker");
const { createTrackerFeed, validateManifest, releasePrefix, manifestUrl } = require("../src/trackerUpdates");

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const exeBytes = (tag, size = 4096) => Buffer.concat([Buffer.from("MZ" + tag), Buffer.alloc(size, 7)]);

/** A local stand-in for GitHub: serves tracker.json (behind a redirect, like GitHub does) and the .exe files. */
async function fakeGitHub(initial) {
  const g = { manifest: initial, files: {}, hits: [], break: null };
  const server = http.createServer((req, res) => {
    g.hits.push(req.url);
    if (req.url === "/latest/download/tracker.json") { res.writeHead(302, { location: "/assets/tracker.json" }); return res.end(); }
    if (req.url === "/assets/tracker.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(g.manifest)); }
    const file = g.files[req.url];
    if (!file) { res.writeHead(404); return res.end(); }
    if (g.break === "truncate") { res.writeHead(200); return res.end(file.subarray(0, file.length - 10)); }
    res.writeHead(302 === g.redirectFiles ? 302 : 200, g.redirectFiles ? { location: "/blob" + req.url } : {});
    res.end(g.redirectFiles ? undefined : file);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  g.base = `http://127.0.0.1:${server.address().port}`;
  g.close = () => new Promise((r) => server.close(r));
  g.publish = (version, tag, mutate = (m) => m) => {
    const bytes = exeBytes(tag);
    g.files[`/dl/v${version}/StratusLink.exe`] = bytes;
    g.manifest = mutate({ version, sha256: sha(bytes), size: bytes.length, url: `${g.base}/dl/v${version}/StratusLink.exe` });
  };
  return g;
}

function setup(g, { bundledVersion = "0.9.21" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stratus-feed-"));
  const bundledExe = path.join(dir, "bundled", "StratusLink.exe");
  const installDir = path.join(dir, "local", "stratus-link");
  fs.mkdirSync(path.dirname(bundledExe), { recursive: true });
  fs.writeFileSync(bundledExe, exeBytes("bundled"));
  if (bundledVersion) fs.writeFileSync(path.join(path.dirname(bundledExe), "version.txt"), bundledVersion + "\n");
  const manager = createTrackerManager({ platform: "win32", bundledExe, installDir, run: async () => ({ stdout: "" }), spawn() {}, sleep: async () => {} });
  const states = [];
  const feed = createTrackerFeed({
    repo: "axiometra/StratusLink-Releases", allowedPrefix: `${g.base}/dl/`, feedUrl: `${g.base}/latest/download/tracker.json`,
    fetchImpl: fetch, manager, tmpDir: path.join(installDir, "downloads"), onChange: (s) => states.push(s.status),
  });
  return { dir, bundledExe, installDir, manager, feed, states };
}

test("real GitHub addresses are built correctly", () => {
  assert.equal(releasePrefix("axiometra/StratusLink-Releases"), "https://github.com/axiometra/StratusLink-Releases/releases/download/");
  assert.equal(manifestUrl("axiometra/StratusLink-Releases"), "https://github.com/axiometra/StratusLink-Releases/releases/latest/download/tracker.json");
});

test("manifest validation rejects anything that is not exactly what we publish", () => {
  const prefix = releasePrefix("axiometra/StratusLink-Releases");
  const good = { version: "0.9.22", sha256: "a".repeat(64), size: 13000000, url: `${prefix}v0.9.22/StratusLink.exe` };
  assert.equal(validateManifest(good, { allowedPrefix: prefix }).ok, true);
  const bad = (patch) => validateManifest({ ...good, ...patch }, { allowedPrefix: prefix }).ok;
  assert.equal(bad({ version: "latest" }), false);
  assert.equal(bad({ sha256: "abc" }), false);
  assert.equal(bad({ sha256: undefined }), false);
  assert.equal(bad({ size: 10 }), false);
  assert.equal(bad({ size: 999999999 }), false);
  assert.equal(bad({ url: "https://evil.example/v0.9.22/StratusLink.exe" }), false);
  assert.equal(bad({ url: "http://github.com/axiometra/StratusLink-Releases/releases/download/v1/StratusLink.exe" }), false, "plain http");
  assert.equal(bad({ url: `${prefix}v0.9.22/other.exe` }), false);
  assert.equal(bad({ url: `${prefix}v0.9.22/StratusLink.exe?x=1` }), false);
  assert.equal(bad({ url: `https://github.com/axiometra/Other/releases/download/v1/StratusLink.exe` }), false, "a different repository");
  assert.equal(validateManifest(null, { allowedPrefix: prefix }).ok, false);
});

test("a newer tracker is downloaded, verified and staged; the running copy is untouched", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  const w = setup(g);
  w.manager.ensureInstalled();                                    // 0.9.21 installed from the bundle
  const installedBefore = fs.readFileSync(path.join(w.installDir, "StratusLink.exe"));
  const st = await w.feed.check();
  assert.equal(st.status, "ready"); assert.equal(st.version, "0.9.22");
  assert.deepEqual(w.states, ["checking", "downloading", "ready"]);
  assert.equal(w.manager.pendingInfo().version, "0.9.22");
  assert.deepEqual(fs.readFileSync(path.join(w.installDir, "StratusLink.exe")), installedBefore, "installed copy not replaced yet");
  assert.equal(fs.existsSync(path.join(w.installDir, "downloads", "StratusLink-0.9.22.exe.part")), false, "no partial file left");
  await g.close();
});

test("the staged update is applied the next time it is safe, and not downloaded again", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  const w = setup(g);
  w.manager.ensureInstalled();
  await w.feed.check();
  const downloads = g.hits.filter((u) => u.includes("/dl/")).length;
  assert.equal(await w.manager.applyPendingIfIdle(), true);
  assert.equal(w.manager.installedInfo().version, "0.9.22");
  assert.equal(w.manager.pendingInfo().exists, false);
  assert.equal(fs.readFileSync(path.join(w.installDir, "StratusLink.exe")).subarray(0, 5).toString(), "MZnew");
  assert.equal((await w.feed.check()).status, "up-to-date");
  assert.equal(g.hits.filter((u) => u.includes("/dl/")).length, downloads, "no second download");
  await g.close();
});

test("an update waiting in the pending folder is not downloaded twice either", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  const w = setup(g);
  await w.feed.check(); await w.feed.check();
  assert.equal(g.hits.filter((u) => u.includes("/dl/")).length, 1);
  await g.close();
});

test("an update is never applied while Stratus Link is running", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  const w = setup(g);
  w.manager.ensureInstalled();
  await w.feed.check();
  const running = createTrackerManager({ platform: "win32", bundledExe: w.bundledExe, installDir: w.installDir,
    run: async () => ({ stdout: '"StratusLink.exe","4001","Console","1","1 K"' }), spawn() {}, sleep: async () => {} });
  assert.equal(await running.applyPendingIfIdle(), false);
  assert.equal(running.pendingInfo().version, "0.9.22");
  await g.close();
});

test("same or older versions are ignored", async () => {
  const g = await fakeGitHub(); g.publish("0.9.21", "same");
  const w = setup(g);
  assert.equal((await w.feed.check()).status, "up-to-date");
  g.publish("0.9.5", "older");
  assert.equal((await w.feed.check()).status, "up-to-date");
  assert.equal(g.hits.filter((u) => u.includes("/dl/")).length, 0);
  await g.close();
});

test("a wrong checksum, a truncated file or a non-program is rejected and leaves nothing behind", async () => {
  for (const scenario of ["checksum", "truncate", "notexe"]) {
    const g = await fakeGitHub();
    if (scenario === "checksum") g.publish("0.9.22", "new", (m) => ({ ...m, sha256: "0".repeat(64) }));
    else if (scenario === "truncate") { g.publish("0.9.22", "new"); g.break = "truncate"; }
    else {
      const bytes = Buffer.alloc(5000, 65);
      g.files["/dl/v0.9.22/StratusLink.exe"] = bytes;
      g.manifest = { version: "0.9.22", sha256: sha(bytes), size: bytes.length, url: `${g.base}/dl/v0.9.22/StratusLink.exe` };
    }
    const w = setup(g);
    const st = await w.feed.check();
    assert.equal(st.status, "error", scenario);
    assert.equal(w.manager.pendingInfo().exists, false, scenario);
    const left = fs.existsSync(path.join(w.installDir, "downloads")) ? fs.readdirSync(path.join(w.installDir, "downloads")) : [];
    assert.deepEqual(left, [], scenario + " leftovers");
    await g.close();
  }
});

test("a download larger than the manifest promised is cut off", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  g.manifest = { ...g.manifest, size: 2000 };      // claims 2000 bytes, serves ~4100
  const w = setup(g);
  const st = await w.feed.check();
  assert.equal(st.status, "error");
  assert.match(st.error, /larger than expected/);
  await g.close();
});

test("network trouble is reported quietly and can be retried", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  const w = setup(g);
  g.manifest = "not json at all";
  assert.equal((await w.feed.check()).status, "error");
  g.publish("0.9.22", "new");
  assert.equal((await w.feed.check()).status, "ready");
  await g.close();
});

test("two checks at once share one run", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  const w = setup(g);
  await Promise.all([w.feed.check(), w.feed.check()]);
  assert.equal(g.hits.filter((u) => u.includes("/dl/")).length, 1);
  await g.close();
});

test("version rules: a newer Companion bundle wins, a self-updated tracker survives a Companion update", async () => {
  const g = await fakeGitHub(); g.publish("0.9.30", "selfupdated");
  const w = setup(g, { bundledVersion: "0.9.21" });
  w.manager.ensureInstalled();                       // 0.9.21 from bundle
  await w.feed.check(); await w.manager.applyPendingIfIdle();
  assert.equal(w.manager.installedInfo().version, "0.9.30");

  // Companion updates and ships an OLDER tracker than the self-updated one: keep the newer one.
  fs.writeFileSync(w.bundledExe, exeBytes("bundled-0.9.25")); fs.writeFileSync(path.join(path.dirname(w.bundledExe), "version.txt"), "0.9.25");
  w.manager.ensureInstalled();
  assert.equal(w.manager.installedInfo().version, "0.9.30");
  assert.equal(fs.readFileSync(path.join(w.installDir, "StratusLink.exe")).subarray(0, 5).toString(), "MZsel");

  // Companion ships a tracker NEWER than the installed one: it replaces it.
  fs.writeFileSync(w.bundledExe, exeBytes("bundled-1.0.0")); fs.writeFileSync(path.join(path.dirname(w.bundledExe), "version.txt"), "1.0.0");
  w.manager.ensureInstalled();
  assert.equal(w.manager.installedInfo().version, "1.0.0");
  await g.close();
});

test("a stale pending update older than the installed tracker is discarded", async () => {
  const g = await fakeGitHub(); g.publish("0.9.22", "new");
  const w = setup(g);
  await w.feed.check();                              // 0.9.22 pending
  fs.writeFileSync(path.join(path.dirname(w.bundledExe), "version.txt"), "1.0.0");
  fs.writeFileSync(w.bundledExe, exeBytes("bundled-1.0.0"));
  w.manager.ensureInstalled();
  assert.equal(w.manager.installedInfo().version, "1.0.0");
  assert.equal(w.manager.pendingInfo().exists, false);
  await g.close();
});
