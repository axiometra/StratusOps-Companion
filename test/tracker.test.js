"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createTrackerManager, parseTasklist } = require("../src/tracker");

const row = (pid) => `"StratusLink.exe","${pid}","Console","1","41,212 K"`;

// A pretend Windows: tracks which StratusLink processes are "running" and records every command.
function world({ bundled = true, platform = "win32", spawnFails = false, dies = false, stubborn = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stratus-tracker-"));
  const bundledExe = path.join(dir, "bundled", "StratusLink.exe");
  const installDir = path.join(dir, "local", "stratus-link");
  if (bundled) { fs.mkdirSync(path.dirname(bundledExe), { recursive: true }); fs.writeFileSync(bundledExe, "MZ-version-1"); }
  const w = { dir, bundledExe, installDir, pids: [], commands: [], spawned: [], changes: [] };
  const run = async (cmd, args) => {
    w.commands.push([cmd, ...args].join(" "));
    if (cmd === "tasklist") return { stdout: w.pids.length ? w.pids.map(row).join("\r\n") : "INFO: No tasks are running which match the specified criteria." };
    if (cmd === "taskkill") {
      const force = args.includes("/F");
      if (!stubborn || force) w.pids = [];
      return { stdout: "" };
    }
    throw new Error("unexpected " + cmd);
  };
  const spawn = (exe, args, opts) => {
    w.spawned.push({ exe, args, opts });
    const child = new EventEmitter();
    child.unref = () => { child.unreffed = true; };
    w.child = child;
    if (spawnFails) setImmediate(() => child.emit("error", new Error("spawn EPERM")));
    else if (!dies) w.pids = [4001, 4002]; // launcher + program
    return child;
  };
  w.manager = createTrackerManager({ platform, bundledExe, installDir, run, spawn, sleep: () => new Promise((r) => setImmediate(r)), onChange: (s) => w.changes.push(s.state) });
  return w;
}

test("parses tasklist output, including the two-process launcher/program pair", () => {
  assert.deepEqual(parseTasklist(`${row(4001)}\r\n${row(4002)}\r\n"other.exe","9","Console","1","1 K"`), [4001, 4002]);
  assert.deepEqual(parseTasklist("INFO: No tasks are running which match the specified criteria."), []);
  assert.deepEqual(parseTasklist(""), []);
});

test("status: stopped, running, not included, unsupported", async () => {
  const a = world();
  assert.equal((await a.manager.refresh()).state, "stopped");
  a.pids = [1];
  assert.equal((await a.manager.refresh()).state, "running");
  assert.equal((await world({ bundled: false }).manager.refresh()).state, "not-bundled");
  assert.equal((await world({ platform: "linux" }).manager.refresh()).state, "unsupported");
});

test("a copy started outside the Companion still counts as running even if none is bundled", async () => {
  const w = world({ bundled: false });
  w.pids = [77];
  assert.equal((await w.manager.refresh()).state, "running");
});

test("start copies the tracker to a per-user folder and launches it detached", async () => {
  const w = world();
  const r = await w.manager.start();
  assert.deepEqual(r, { ok: true });
  assert.equal(w.spawned.length, 1);
  assert.equal(w.spawned[0].exe, path.join(w.installDir, "StratusLink.exe"));
  assert.equal(w.spawned[0].opts.detached, true);
  assert.equal(w.child.unreffed, true);
  assert.equal(fs.readFileSync(path.join(w.installDir, "StratusLink.exe"), "utf8"), "MZ-version-1");
  assert.ok(w.changes.includes("running"));
});

test("start never launches a second copy", async () => {
  const w = world();
  w.pids = [55];
  const r = await w.manager.start();
  assert.equal(r.alreadyRunning, true);
  assert.equal(w.spawned.length, 0);
});

test("a newer bundled tracker replaces the old per-user copy, an identical one is left alone", async () => {
  const w = world();
  await w.manager.start();
  w.pids = [];
  const installed = path.join(w.installDir, "StratusLink.exe");
  const before = fs.statSync(installed).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await w.manager.start();                       // identical: not rewritten
  assert.equal(fs.statSync(installed).mtimeMs, before);
  w.pids = [];
  fs.writeFileSync(w.bundledExe, "MZ-version-2"); // app update ships a newer tracker
  await w.manager.start();
  assert.equal(fs.readFileSync(installed, "utf8"), "MZ-version-2");
});

test("start reports a clear message when the program is not bundled, unsupported, blocked or closes at once", async () => {
  assert.match((await world({ bundled: false }).manager.start()).error, /does not include/);
  assert.match((await world({ platform: "darwin" }).manager.start()).error, /only runs on Windows/);
  assert.match((await world({ spawnFails: true }).manager.start()).error, /could not start: spawn EPERM/);
  assert.match((await world({ dies: true }).manager.start()).error, /closed straight away/);
});

test("stop asks politely first and does not force when that works", async () => {
  const w = world();
  w.pids = [4001, 4002];
  assert.deepEqual(await w.manager.stop(), { ok: true });
  const kills = w.commands.filter((c) => c.startsWith("taskkill"));
  assert.deepEqual(kills, ["taskkill /PID 4001 /T", "taskkill /PID 4002 /T"]);
});

test("stop forces the program closed only if it ignores the polite request", async () => {
  const w = world({ stubborn: true });
  w.pids = [4001, 4002];
  assert.deepEqual(await w.manager.stop(), { ok: true });
  assert.ok(w.commands.some((c) => c === "taskkill /PID 4001 /T /F"));
});

test("stop with nothing running does nothing", async () => {
  const w = world();
  assert.deepEqual(await w.manager.stop(), { ok: true });
  assert.equal(w.commands.filter((c) => c.startsWith("taskkill")).length, 0);
});

test("a failing tasklist is treated as not running, not a crash", async () => {
  const w = world();
  const m = createTrackerManager({ platform: "win32", bundledExe: w.bundledExe, installDir: w.installDir,
    run: async () => { throw new Error("tasklist missing"); }, spawn() {}, sleep: async () => {} });
  assert.equal((await m.refresh()).state, "stopped");
});
