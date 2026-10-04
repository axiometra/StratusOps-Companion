"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createUpdater } = require("../src/updates");

function fakeUpdater(behaviour) {
  const au = new EventEmitter();
  au.checks = 0;
  au.installed = null;
  au.checkForUpdates = async () => { au.checks++; return behaviour(au); };
  au.quitAndInstall = (silent, run) => { au.installed = { silent, run }; };
  return au;
}
const make = (au, enabled = true) => {
  const seen = [];
  const u = createUpdater({ autoUpdater: au, enabled, onChange: (s) => seen.push(s.status), timers: { setTimeout() {}, setInterval() {} } });
  return { u, seen };
};

test("disabled copies (zip/dev) never touch the updater", async () => {
  const au = fakeUpdater(() => { throw new Error("must not be called"); });
  const { u } = make(au, false);
  assert.equal(u.state().status, "disabled");
  await u.check();
  assert.equal(au.checks, 0);
  assert.equal(u.installNow(), false);
});

test("settings: background download, install on quit, no prereleases", () => {
  const au = fakeUpdater(() => {});
  make(au);
  assert.equal(au.autoDownload, true);
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.allowPrerelease, false);
});

test("up to date", async () => {
  const au = fakeUpdater((a) => { a.emit("checking-for-update"); a.emit("update-not-available", {}); });
  const { u, seen } = make(au);
  assert.equal((await u.check()).status, "up-to-date");
  assert.deepEqual(seen, ["checking", "up-to-date"]);
});

test("update found, downloaded, then installed on request", async () => {
  const au = fakeUpdater((a) => {
    a.emit("checking-for-update");
    a.emit("update-available", { version: "0.3.1" });
    a.emit("download-progress", { percent: 41.6 });
    a.emit("update-downloaded", { version: "0.3.1" });
  });
  const { u } = make(au);
  const s = await u.check();
  assert.equal(s.status, "ready");
  assert.equal(s.version, "0.3.1");
  assert.equal(u.installNow(), true);
  assert.deepEqual(au.installed, { silent: true, run: true });
});

test("installNow does nothing unless an update is ready", async () => {
  const au = fakeUpdater((a) => { a.emit("update-not-available", {}); });
  const { u } = make(au);
  await u.check();
  assert.equal(u.installNow(), false);
  assert.equal(au.installed, null);
});

test("a failed check is reported, not thrown, and can be retried", async () => {
  let fail = true;
  const au = fakeUpdater((a) => { if (fail) throw new Error("net::ERR_INTERNET_DISCONNECTED\nstack..."); a.emit("update-not-available", {}); });
  const { u } = make(au);
  const bad = await u.check();
  assert.equal(bad.status, "error");
  assert.equal(bad.error, "net::ERR_INTERNET_DISCONNECTED");
  fail = false;
  assert.equal((await u.check()).status, "up-to-date");
});

test("a finished or running download is never restarted by another check", async () => {
  const au = fakeUpdater((a) => { a.emit("update-available", { version: "0.3.1" }); a.emit("update-downloaded", { version: "0.3.1" }); });
  const { u } = make(au);
  await u.check();
  await u.check();
  assert.equal(au.checks, 1);
});

test("start schedules a first check and a repeating check", () => {
  const calls = [];
  const au = fakeUpdater(() => {});
  const u = createUpdater({ autoUpdater: au, enabled: true, onChange() {}, intervalMs: 1000, firstCheckDelayMs: 50,
    timers: { setTimeout: (fn, ms) => calls.push(["first", ms]), setInterval: (fn, ms) => calls.push(["every", ms]) } });
  u.start();
  assert.deepEqual(calls, [["first", 50], ["every", 1000]]);
});
