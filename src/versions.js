"use strict";
// Version numbers like "0.9.21" (two to four numeric parts).
const VERSION_RE = /^\d+(\.\d+){1,3}$/;

const isVersion = (v) => typeof v === "string" && VERSION_RE.test(v.trim());

/** -1 / 0 / 1 like a sort comparator; an invalid or missing version counts as older than any valid one. */
function compareVersions(a, b) {
  const va = isVersion(a), vb = isVersion(b);
  if (!va && !vb) return 0;
  if (!va) return -1;
  if (!vb) return 1;
  const pa = a.trim().split(".").map(Number), pb = b.trim().split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

module.exports = { isVersion, compareVersions };
