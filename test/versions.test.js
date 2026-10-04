"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isVersion, compareVersions } = require("../src/versions");

test("version numbers", () => {
  for (const ok of ["0.9.21", "1.0", "10.2.3.4"]) assert.equal(isVersion(ok), true, ok);
  for (const bad of ["", "v1.0.0", "1", "1.0.0.0.0", "1.a", "1..2", null, undefined, 5]) assert.equal(isVersion(bad), false, String(bad));
});

test("comparison is numeric, not alphabetical", () => {
  assert.equal(compareVersions("0.9.21", "0.9.9"), 1);
  assert.equal(compareVersions("0.9.9", "0.9.21"), -1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.10.0", "0.9.99"), 1);
});

test("a missing or invalid version is older than any real one", () => {
  assert.equal(compareVersions(null, "0.0.1"), -1);
  assert.equal(compareVersions("0.0.1", "junk"), 1);
  assert.equal(compareVersions(undefined, null), 0);
});
