# CYOA Helper

A small program for cyoa.cafe moderators. It runs on your own computer and does the heavy work
for the **Mod Tools** page on the site. It downloads a game from its link, checks that nothing is
missing, lets you play the local copy, and uploads it to the author's page on cyoa.cafe hosting.

It is useless without a cyoa.cafe moderator account that has the "Mod uploads" permission. Every
action goes through the site, and the site decides what is allowed.

## Install

1. Download the file for your system from the
   [releases page](https://github.com/DragonsWho/CYOACatalog/releases/latest):
   - Windows: `cyoa-helper-windows.exe`
   - macOS (Apple Silicon): `cyoa-helper-macos`. Use `cyoa-helper-macos-intel` for older Intel Macs.
   - Linux: `cyoa-helper-linux`
2. Start it.
   - **Windows:** double-click it. If SmartScreen warns you, click "More info", then "Run anyway".
   - **macOS:** open Terminal and run `chmod +x ~/Downloads/cyoa-helper-macos`. Then
     right-click the file, choose Open, and confirm. You only do this the first time.
   - **Linux:** run `chmod +x cyoa-helper-linux && ./cyoa-helper-linux`.

A window with a numbered menu appears. Type a number and press Enter.

## First time: connect

1. Choose **1 Connect**. The helper shows a code like `K7QM-3XRP` and opens the Mod Tools page.
2. Log in on the site with your moderator account and press **Connect**.
3. The helper says "Connected as …". Leave its window open while you work.

To stop using a computer, press **Disconnect** next to it on the Mod Tools page.

## Everyday use

Do everything on the **Mod Tools** page. The helper just needs to be running.

1. Paste the game's link and press **Download**.
2. Read the check report, then open **Play the downloaded copy** to make sure the game works.
3. Below the report, pick or create the author's hosting account, then upload.
4. Fill in the card: title, authors, tags, a description and a cover. Use Screenshot Studio for
   the cover. Then send the card to the publication queue.

Another moderator checks your card in the queue before it goes live.

The menu can also:
- **2** download a game from a link.
- **3** import a game you already have as a folder or a `.zip`. You can drag it into the window.
- **4** list your downloaded games: play, re-check, open the folder, or delete.

Games are stored in `CYOA Helper` in your home folder. Change this with **6 Settings**.

## What it will not do

- Download from web archives, or fix games that no longer exist online. Ask the admin for those.
- Replace a game that is already on hosting.
- Upload under your own account. Games always go to the author's page.
- Connect to addresses on your local network.

## For developers

```
go test ./...
go build -o cyoa-helper .
CYOA_HELPER_SERVER=http://127.0.0.1:8090 ./cyoa-helper   # against a local dev server
CYOA_LIVE_URL=https://example.neocities.org/game/ go test -run TestLive -v   # crawl a real game
```

The server side lives in the site repo: `modkit.go` holds the pairing, jobs and upload parts, and
`src/components/ModTools/` holds the page. The helper only ever receives job ids and workspace
item ids from the site, never local paths. Uploads use the author, slot and title stored in the
server-side job, not values from the helper.

Releases: push a tag like `helper-v0.1.0`. `.github/workflows/cyoa-helper-release.yml` then
builds the binaries and attaches them to the release.
