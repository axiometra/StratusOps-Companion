"use strict";

// Where the Companion lives. STRATUS_ORIGIN lets a developer point the shell at
// a preview build while testing; players always get the production default.
const APP_ORIGIN = (process.env.STRATUS_ORIGIN || "https://stratusops.app").replace(/\/+$/, "");
const START_PATH = "/companion";
const FULL_SITE_PATH = "/dashboard";

// Pages that live inside the small Companion window: the Companion itself, plus the
// sign-in and password-reset pages it redirects to.
const COMPANION_PATHS = ["/companion", "/auth", "/reset-password"];

function onCompanionPath(pathname) {
  return COMPANION_PATHS.some((p) => pathname === p || pathname === `${p}/`);
}

function parse(rawUrl) {
  try {
    return new URL(rawUrl);
  } catch {
    return null;
  }
}

/**
 * What should happen to a URL the Companion window wants to open?
 *  - "internal": load it inside the Companion window
 *  - "site":     open it in the full-site window (same sign-in as the Companion)
 *  - "external": hand it to the player's default browser (https only)
 *  - "block":    do nothing
 */
function classifyUrl(rawUrl) {
  const url = parse(rawUrl);
  if (!url) return "block";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "block";
  if (url.origin === APP_ORIGIN) return onCompanionPath(url.pathname) ? "internal" : "site";
  // Plain http is never opened externally; only https links leave the app.
  return url.protocol === "https:" ? "external" : "block";
}

/**
 * Same question for the full-site window: the whole Stratus OPs site stays in the
 * window, everything else goes to the default browser.
 */
function classifyForSite(rawUrl) {
  const url = parse(rawUrl);
  if (!url) return "block";
  if (url.protocol !== "https:" && url.protocol !== "http:") return "block";
  if (url.origin === APP_ORIGIN) return "internal";
  return url.protocol === "https:" ? "external" : "block";
}

module.exports = { APP_ORIGIN, START_PATH, FULL_SITE_PATH, COMPANION_PATHS, classifyUrl, classifyForSite };
