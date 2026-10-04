"use strict";
// Build settings for the Windows installer. Read by `electron-builder` automatically.
const pkg = require("./package.json");

// Where updates are published. In GitHub Actions this is filled in automatically from the
// repository the build runs in. Local builds have no publish target, so the resulting app
// simply has automatic updates switched off.
const slug = process.env.GITHUB_REPOSITORY || "";
const [owner, repo] = slug.split("/");

// Code signing is optional and switched on by the secrets you add to GitHub (see RELEASING.md).
//  - Azure Artifact Signing: set all four AZURE_SIGN_* values (plus the AZURE_TENANT_ID,
//    AZURE_CLIENT_ID and AZURE_CLIENT_SECRET login secrets).
//  - A classic certificate file: set WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD (electron-builder
//    picks these up by itself).
const azure = process.env.AZURE_SIGN_ENDPOINT && process.env.AZURE_SIGN_ACCOUNT &&
  process.env.AZURE_SIGN_PROFILE && process.env.AZURE_SIGN_PUBLISHER
  ? {
      endpoint: process.env.AZURE_SIGN_ENDPOINT,
      codeSigningAccountName: process.env.AZURE_SIGN_ACCOUNT,
      certificateProfileName: process.env.AZURE_SIGN_PROFILE,
      publisherName: process.env.AZURE_SIGN_PUBLISHER,
    }
  : undefined;

module.exports = {
  appId: "com.axiometra.stratuscompanion",
  productName: pkg.productName,
  copyright: "Copyright (c) Axiometra Limited",
  directories: { output: "dist" },
  files: ["src/**/*", "assets/**/*", "package.json"],
  // The Stratus Link tracker (bundled/StratusLink.exe) is copied next to the app. If the file is
  // not there the installer is still built, just without the tracker.
  extraResources: [{ from: "bundled", to: "stratus-link", filter: ["StratusLink.exe"] }],
  // Releases are uploaded as DRAFTS by default; you publish them by hand (see RELEASING.md).
  publish: owner && repo ? [{ provider: "github", owner, repo }] : undefined,
  win: {
    icon: "assets/icon.ico",
    target: [{ target: "nsis", arch: ["x64"] }],
    ...(azure ? { azureSignOptions: azure } : {}),
  },
  nsis: {
    oneClick: false,                       // normal installer pages
    perMachine: false,                     // installs for the current user: no admin rights needed
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    runAfterFinish: true,
    deleteAppDataOnUninstall: false,       // keep sign-in/window settings if reinstalled
    // A fixed file name gives a permanent link:
    // https://github.com/<owner>/<repo>/releases/latest/download/StratusOPsCompanion-Setup.exe
    artifactName: "StratusOPsCompanion-Setup.exe",
  },
};
