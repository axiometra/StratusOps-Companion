"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SIZES = {
  standard: { width: 420, height: 680 },
  compact: { width: 420, height: 160 },
  site: { width: 1280, height: 800 }, // the window while it shows the full Stratus OPs site
};
const MIN_SIZE = { width: 320, height: 120 };
const OPACITY_CHOICES = [1, 0.85, 0.7];

const DEFAULTS = Object.freeze({
  mode: "standard",
  x: undefined,
  y: undefined,
  sizes: DEFAULT_SIZES,
  alwaysOnTop: true,
  opacity: 1,
  trayNoticeShown: false,
  startTracker: false, // start the bundled Stratus Link whenever the Companion starts
});

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function sanitiseSize(raw, fallback) {
  if (!raw || !isNum(raw.width) || !isNum(raw.height)) return { ...fallback };
  return {
    width: Math.max(MIN_SIZE.width, Math.round(raw.width)),
    height: Math.max(MIN_SIZE.height, Math.round(raw.height)),
  };
}

/** Turn whatever was read from disk into a complete, safe settings object. */
function sanitise(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  const sizes = r.sizes && typeof r.sizes === "object" ? r.sizes : {};
  return {
    mode: r.mode === "compact" ? "compact" : "standard",
    x: isNum(r.x) ? Math.round(r.x) : undefined,
    y: isNum(r.y) ? Math.round(r.y) : undefined,
    sizes: {
      standard: sanitiseSize(sizes.standard, DEFAULT_SIZES.standard),
      compact: sanitiseSize(sizes.compact, DEFAULT_SIZES.compact),
      site: sanitiseSize(sizes.site, DEFAULT_SIZES.site),
    },
    alwaysOnTop: typeof r.alwaysOnTop === "boolean" ? r.alwaysOnTop : DEFAULTS.alwaysOnTop,
    opacity: OPACITY_CHOICES.includes(r.opacity) ? r.opacity : DEFAULTS.opacity,
    trayNoticeShown: r.trayNoticeShown === true,
    startTracker: r.startTracker === true,
  };
}

/**
 * Work out where to put the window. If the remembered position is no longer on a
 * connected monitor (e.g. a second screen was unplugged) the position is dropped so
 * the window opens centred instead of off-screen. Size is capped to the biggest screen.
 */
function fitBounds(settings, workAreas) {
  const size = { ...settings.sizes[settings.mode] };
  if (workAreas.length) {
    const maxW = Math.max(...workAreas.map((a) => a.width));
    const maxH = Math.max(...workAreas.map((a) => a.height));
    size.width = Math.min(size.width, maxW);
    size.height = Math.min(size.height, maxH);
  }
  if (settings.x === undefined || settings.y === undefined) return size;

  const MIN_VISIBLE_W = 100;
  const MIN_VISIBLE_H = 50;
  const visible = workAreas.some((a) => {
    const w = Math.min(settings.x + size.width, a.x + a.width) - Math.max(settings.x, a.x);
    const h = Math.min(settings.y + size.height, a.y + a.height) - Math.max(settings.y, a.y);
    return w >= MIN_VISIBLE_W && h >= MIN_VISIBLE_H;
  });
  return visible ? { x: settings.x, y: settings.y, ...size } : size;
}

function load(file) {
  try {
    return sanitise(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return sanitise(null);
  }
}

function save(file, settings) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
  } catch {
    /* A read-only profile must never stop the app from running. */
  }
}

module.exports = { DEFAULT_SIZES, MIN_SIZE, OPACITY_CHOICES, sanitise, fitBounds, load, save };
