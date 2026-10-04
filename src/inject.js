"use strict";
// Small scripts the shell runs inside the Stratus OPs pages. Each is idempotent and fails quietly:
// if the page changes shape, the worst case is the extra element not appearing.

// "App v<version>" in the Companion page's own footer, between the update time and the
// "Open full site" link. A watcher re-adds it if the page redraws its footer; only acts on /companion.
function versionFooterScript(version) {
  return `(() => {
    if (window.__stratusShellVersion) return;
    window.__stratusShellVersion = true;
    const label = "App v" + ${JSON.stringify(version)};
    const apply = () => {
      const p = location.pathname.length > 1 && location.pathname.endsWith("/") ? location.pathname.slice(0, -1) : location.pathname;
      if (p !== "/companion") return;
      const footer = document.querySelector("main footer") || document.querySelector("footer");
      if (!footer || footer.querySelector("[data-shell-version]")) return;
      const el = document.createElement("span");
      el.setAttribute("data-shell-version", "");
      el.textContent = label;
      el.style.whiteSpace = "nowrap";
      footer.insertBefore(el, footer.lastElementChild);
    };
    apply();
    new MutationObserver(apply).observe(document.body, { childList: true, subtree: true });
  })()`;
}

// A floating "Back to Companion" button on every page except the small Companion pages. Clicking
// it loads the Companion URL, and the shell then shrinks the window back to Companion size.
// Built inside a closed shadow root so the site's own styles and scripts cannot touch it.
function backButtonScript(companionUrl, smallPagePaths) {
  return `(() => {
    if (window.__stratusBackButton) return;
    window.__stratusBackButton = true;
    const target = ${JSON.stringify(companionUrl)};
    const smallPages = ${JSON.stringify(smallPagePaths)};
    const ID = "stratus-back-to-companion";
    const onSmallPage = () => {
      const p = location.pathname.length > 1 && location.pathname.endsWith("/") ? location.pathname.slice(0, -1) : location.pathname;
      return smallPages.includes(p);
    };
    const build = () => {
      const host = document.createElement("div");
      host.id = ID;
      host.style.cssText = "all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;";
      const root = host.attachShadow({ mode: "closed" });
      const style = document.createElement("style");
      style.textContent = "button{font:600 12px 'Segoe UI',system-ui,sans-serif;color:#e6edf3;background:#0b0f14;border:1px solid #1f6feb;border-radius:2px;padding:8px 12px;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.5)}button:hover{background:#1f6feb}button:focus-visible{outline:2px solid #e6edf3;outline-offset:2px}";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "\u2190 Back to Companion";
      btn.title = "Return to the small Companion window";
      btn.addEventListener("click", () => { location.assign(target); });
      root.append(style, btn);
      return host;
    };
    const apply = () => {
      const existing = document.getElementById(ID);
      if (onSmallPage()) { if (existing) existing.remove(); return; }
      if (!existing && document.body) document.body.appendChild(build());
    };
    apply();
    new MutationObserver(apply).observe(document.documentElement, { childList: true, subtree: true });
    setInterval(apply, 1000);
  })()`;
}

module.exports = { versionFooterScript, backButtonScript };
