# Releasing the Stratus OPs Companion

Plain-language steps for putting the installer in players' hands and keeping it updated.
You do this on GitHub; nothing here needs a Windows PC of your own (GitHub builds the installer on its own Windows machine).

## One-time setup

1. **Create a GitHub repository** (for example `stratus-companion`) under the Axiometra account or organisation.
   **Make it public.** Installed copies download updates from its Releases page, and a private repository would need every player to log in to GitHub. If you don't want the source code visible, create a second *public* repository used only for releases and ask your developer to point `publish` at it in `electron-builder.config.js`.
2. **Upload this folder's contents.** Unzip the source zip on your PC. On the new empty repository page click **uploading an existing file**, then drag in everything *inside* the unzipped folder (so that `package.json` and the `.github` folder sit at the top level of the repository, not inside another folder). Write a short message such as "First version" and press **Commit changes**. (Developers can use `git push` instead.)
3. In the repository go to **Settings, Actions, General, Workflow permissions** and choose **Read and write permissions**. Save.

## Including (and updating) Stratus Link

The installer carries the Stratus Link tracker, but only if the file is in the repository's `bundled` folder:

1. While signed in to Stratus OPs, download the latest Stratus Link zip from the **Connections** page and unzip it.
2. In the repository open the `bundled` folder, choose **Add file, Upload files**, and drag in the single file
   **`StratusLink.exe`** from inside the unzip (not the zip itself). Replace the existing one if there is one. Commit.
   (A browser upload is limited to 25 MB; the tracker is about 13 MB. Each new version adds about that much to the
   repository's size, which is fine for a long time.)
3. Run the release as normal. The build says in its log which tracker file it bundled. If the file is missing it
   prints a warning and builds an installer **without** the tracker; if the file is not a Windows program
   (for example the zip was uploaded by mistake) it stops with a clear message.

Whenever there is a new Stratus Link version, repeat steps 1 and 2 and release a new Companion version. Players who
install or update get the new tracker automatically the next time they start it from the Companion. (A later stage
will make the tracker update itself without a Companion release.)

## Releasing a version

1. If this is an update, change `"version"` in `package.json` (for example `0.3.0` to `0.3.1`) and commit it (on GitHub: open the file, pencil icon, edit, Commit changes).
2. Open the repository's **Actions** tab, choose **Release installer** on the left, press **Run workflow**, then the green **Run workflow** button.
   (A developer can instead push a tag that matches the version, for example `git tag v0.3.1` then `git push origin v0.3.1`. The build stops with a clear message if the tag and `package.json` differ.)
3. Wait about 5 to 10 minutes. The Actions tab shows progress. When it finishes, **Releases** contains a **draft** with:
   `StratusOPsCompanion-Setup.exe`, a `.blockmap` file and `latest.yml`.
4. **Download the installer from the draft and try it** on a Windows PC (install, sign in, open Job Board, Back to Companion).
5. Press **Publish release**. Only now can players and installed copies see it.

The draft step is deliberate: a broken build never reaches players by accident.

Each version number can only be released once. If a run created a draft you don't want, **delete that draft** on the Releases page (trash icon) before running again for the same version, or raise the version (for example 0.3.1) and release that instead.

## What players get

- **First install:** they download `StratusOPsCompanion-Setup.exe`. A permanent link that always gives the newest installer is
  `https://github.com/<owner>/<repo>/releases/latest/download/StratusOPsCompanion-Setup.exe`
  (this is what a "Download Companion" button on the website would use).
- **Installer:** installs for the current Windows user (no administrator password), adds a desktop and Start menu shortcut, starts the app when finished. Uninstalling keeps their sign-in and window settings in case they reinstall.
- **Updates:** an installed copy checks shortly after it starts and every 4 hours. A new version downloads quietly, then a notification says it is ready. The player can right-click the tray icon and choose **Restart to update**, or do nothing and it installs the next time the app is quit. The tray menu also has **Check for updates...**.
- **Not updated automatically:** the plain `.zip` builds I hand over during testing, and anything run with `npm start`. The tray menu says "Updates: installed copies only" for those.

## Code signing (removes the Windows "unknown publisher" warning)

**The bundled tracker matters here too.** Stratus Link is itself a packaged Python program, the kind antivirus tools often flag as suspicious. Signing the Companion installer does not automatically sign `StratusLink.exe`. Sign the tracker as part of its own build before you upload it, or expect some players' security software to quarantine it (the Companion then reports that Stratus Link closed straight away and points at the security software).

Without signing, Windows SmartScreen warns on download and first run ("Windows protected your PC"). Players can click *More info, Run anyway*, but many will not. Signing is switched on by adding **secrets** in the repository (**Settings, Secrets and variables, Actions**); no code changes are needed. With no secrets, the build is simply unsigned.

**Option A: Azure Artifact Signing (formerly Trusted Signing). Suggested starting point.**
Microsoft's cloud signing service. Check current pricing and eligibility on Microsoft's site before relying on this: at launch it was around $10 a month, open to organisations in the UK, EU, US and Canada, and it validates the company's legal name (for a UK company, against Companies House). Add these secrets:
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` (the sign-in details of an Azure app registration allowed to sign),
`AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE` (from your Artifact Signing account and certificate profile),
`AZURE_SIGN_PUBLISHER` (the publisher name exactly as on the certificate).

**Option B: a certificate from a certificate authority.**
Since 2023 new code-signing keys must live on hardware or in a cloud key vault, so many certificates cannot be exported as a file. Only use this if your provider gives you a downloadable `.pfx`: add `WIN_CSC_LINK` (the file, base64-encoded, or a link) and `WIN_CSC_KEY_PASSWORD`.

Even signed, a brand-new publisher can see a SmartScreen warning for the first days or weeks until the app builds a reputation. Azure's service is designed to give a head start on this.

## Changing the icon

The tray and window icon is `assets/icon.png`; the installer and `.exe` icon is `assets/icon.ico`. Both are currently a placeholder. To use the real logo: replace `assets/icon.png` with a square PNG, at least 256 x 256 pixels, then run `npm run make-icon` and commit both files.

## Troubleshooting

- **Build stops at "Check the tag matches package.json":** the tag and the version number differ. Fix `package.json` or re-tag.
- **Build fails when uploading:** repository Settings, Actions, General, Workflow permissions must be *Read and write*.
- **Installed copy never updates:** the release is still a draft, the repository is private, or the copy was not installed with the installer.
- **"Stratus Link: not included in this copy" in the tray menu:** the installer was built without `bundled/StratusLink.exe`. Upload it and release again.
- **"Stratus Link closed straight away":** Windows security software probably blocked or quarantined it. Check its protection history and allow the file.
- **Players report two windows / an old version after updating:** closing the window only hides the app to the tray. Quit from the tray menu, then start it again. The tray menu shows the running version.
