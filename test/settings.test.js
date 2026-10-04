"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sanitise, fitBounds, load, save } = require("../src/settings");

const screen1 = { x: 0, y: 0, width: 1920, height: 1040 };
const screen2 = { x: 1920, y: 0, width: 1920, height: 1040 };

test("defaults are used when nothing valid is saved", () => {
  const s = sanitise(null);
  assert.equal(s.mode, "standard");
  assert.equal(s.alwaysOnTop, true);
  assert.equal(s.opacity, 1);
  assert.equal(s.startTracker, false, "the tracker never starts by itself unless asked");
  assert.deepEqual(s.sizes.compact, { width: 420, height: 160 });
});

test("garbage values are repaired, not trusted", () => {
  const s = sanitise({ mode: "weird", x: "a", sizes: { standard: { width: 5, height: -3 } }, opacity: 0.1, alwaysOnTop: "yes" });
  assert.equal(s.mode, "standard");
  assert.equal(s.x, undefined);
  assert.deepEqual(s.sizes.standard, { width: 320, height: 120 });
  assert.equal(s.opacity, 1);
  assert.equal(s.alwaysOnTop, true);
});

test("a saved position on a connected monitor is kept", () => {
  const s = sanitise({ x: 2000, y: 100, sizes: { standard: { width: 420, height: 680 } } });
  assert.deepEqual(fitBounds(s, [screen1, screen2]), { x: 2000, y: 100, width: 420, height: 680 });
});

test("a position on an unplugged monitor falls back to centred (no x/y)", () => {
  const s = sanitise({ x: 2000, y: 100 });
  assert.deepEqual(fitBounds(s, [screen1]), { width: 420, height: 680 });
});

test("a window dragged almost fully off-screen is brought back", () => {
  const s = sanitise({ x: 1900, y: 100 });
  assert.equal(fitBounds(s, [screen1]).x, undefined);
});

test("compact mode uses its own remembered size", () => {
  const s = sanitise({ mode: "compact", sizes: { compact: { width: 500, height: 200 } } });
  assert.deepEqual(fitBounds(s, [screen1]), { width: 500, height: 200 });
});

test("settings survive a save and load, and a missing file is fine", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stratus-")), "nested", "settings.json");
  assert.equal(load(file).mode, "standard");
  const s = sanitise({ mode: "compact", opacity: 0.85, alwaysOnTop: false, trayNoticeShown: true });
  save(file, s);
  assert.deepEqual(load(file), s);
});

test("the start-tracker choice is remembered, and only a real true counts", () => {
  assert.equal(sanitise({ startTracker: true }).startTracker, true);
  assert.equal(sanitise({ startTracker: "yes" }).startTracker, false);
});
