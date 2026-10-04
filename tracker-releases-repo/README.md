# Stratus Link releases

This repository only exists to publish new versions of the Stratus Link tracker. Installed copies of the
Stratus OPs Companion check its latest release every few hours and update the tracker by themselves.

## One-time setup

1. Create a **public** repository named `StratusLink-Releases` (the name the Companion expects; it can be
   changed in the Companion's `src/config.js`). Public is required so the Companion can download without a login.
   Leave README, .gitignore and licence off when creating it, then upload this README if you like.
2. In **Settings, Actions, General, Workflow permissions** choose **Read and write permissions**.
3. Add the workflow: **Add file, Create new file**, type the name `.github/workflows/publish-tracker.yml`
   (typing the slashes creates the folders), paste in the contents of `github-workflows/publish-tracker.yml`
   from the Companion source, and commit. (Dot-folders are skipped when you drag files in, which is why it is
   created this way.)

## Publishing a new tracker version

1. Upload the new **`StratusLink.exe`** (the file from inside the Stratus Link zip, not the zip) to the top
   level of this repository, replacing the old one (**Add file, Upload files**), and commit.
2. **Actions, Publish tracker release, Run workflow.** Enter the version (for example `0.9.22`, no `v`) and
   optionally what changed. Version numbers must go up; the Companion ignores anything not newer than what it has.
3. When it finishes (about a minute) open **Releases**. There is a **draft** with `StratusLink.exe` and
   `tracker.json`. Check it, then press **Publish release**. Only now do Companions see it.

A bad release cannot be rolled back by publishing an older number (Companions ignore older versions); publish a
fixed, higher version instead. If you delete a published release before anyone has updated, nothing is lost.

What happens next on a player's PC: within about 6 hours (or when they choose **Check for Stratus Link updates**
in the tray) the Companion downloads it, checks its size, checksum and that it is a Windows program, and keeps it
waiting. It is used the next time Stratus Link is started; if Stratus Link is running, the player is told and can
restart it from the tray whenever it suits. A running flight is never interrupted.
