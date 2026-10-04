"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const load = (env) => JSON.parse(execFileSync(process.execPath, ["-e",
  "console.log(JSON.stringify(require('./electron-builder.config.js')))"], {
  cwd: path.join(__dirname, ".."), env: { ...process.env, GITHUB_REPOSITORY: "", AZURE_SIGN_ENDPOINT: "", ...env }, encoding: "utf8",
}));

test("installer config loads and has the expected shape", () => {
  const c = load({});
  assert.equal(c.productName, "Stratus OPs Companion");
  assert.equal(c.nsis.perMachine, false);
  assert.equal(c.nsis.artifactName, "StratusOPsCompanion-Setup.exe");
  assert.equal(c.win.icon, "assets/icon.ico");
  assert.equal(c.publish, undefined, "local builds have no update feed");
  assert.equal(c.win.azureSignOptions, undefined, "unsigned unless secrets are set");
});

test("in GitHub Actions the update feed points at the repository being built", () => {
  const c = load({ GITHUB_REPOSITORY: "axiometra/stratus-companion" });
  assert.deepEqual(c.publish, [{ provider: "github", owner: "axiometra", repo: "stratus-companion" }]);
});

test("Azure signing switches on only when all four values are present", () => {
  const partial = load({ AZURE_SIGN_ENDPOINT: "https://x", AZURE_SIGN_ACCOUNT: "a" });
  assert.equal(partial.win.azureSignOptions, undefined);
  const full = load({ AZURE_SIGN_ENDPOINT: "https://x", AZURE_SIGN_ACCOUNT: "a", AZURE_SIGN_PROFILE: "p", AZURE_SIGN_PUBLISHER: "Axiometra Limited" });
  assert.equal(full.win.azureSignOptions.publisherName, "Axiometra Limited");
});
