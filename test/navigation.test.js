"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyUrl, classifyForSite } = require("../src/navigation");

test("Companion, sign-in and reset pages stay in the Companion window", () => {
  assert.equal(classifyUrl("https://stratusops.app/companion"), "internal");
  assert.equal(classifyUrl("https://stratusops.app/companion?compact=1"), "internal");
  assert.equal(classifyUrl("https://stratusops.app/auth?redirect=/companion"), "internal");
  assert.equal(classifyUrl("https://stratusops.app/reset-password"), "internal");
});

test("other pages on the site open in the full-site window (same sign-in)", () => {
  assert.equal(classifyUrl("https://stratusops.app/dashboard"), "site");
  assert.equal(classifyUrl("https://stratusops.app/logistics"), "site");
  assert.equal(classifyUrl("https://stratusops.app/companion/../dashboard"), "site");
});

test("other domains go to the default browser from the Companion window", () => {
  assert.equal(classifyUrl("https://example.com/companion"), "external");
  assert.equal(classifyUrl("https://stratusops.app.evil.com/companion"), "external");
  assert.equal(classifyUrl("https://evil.com/?u=https://stratusops.app/companion"), "external");
});

test("non-https and malformed URLs are blocked", () => {
  for (const bad of ["http://example.com", "javascript:alert(1)", "file:///C:/Windows/system32", "not a url", ""]) {
    assert.equal(classifyUrl(bad), "block", bad);
    assert.equal(classifyForSite(bad), "block", bad);
  }
});

test("the full-site window keeps the whole site and sends other domains to the browser", () => {
  assert.equal(classifyForSite("https://stratusops.app/dashboard"), "internal");
  assert.equal(classifyForSite("https://stratusops.app/anything/else?x=1"), "internal");
  assert.equal(classifyForSite("https://stratusops.app.evil.com/"), "external");
  assert.equal(classifyForSite("https://discord.com/oauth2/authorize"), "external");
});
