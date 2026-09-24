# CYOA Helper — add games to cyoa.cafe yourself

CYOA Helper is a small program you run on your own computer. You work on the **Mod Tools** page
of the site, and the helper does the heavy work in the background: it downloads the game, checks
it, lets you play the local copy and uploads it to the author's page (`author.cyoa.cafe/game/`).

It doesn't work without a cyoa.cafe moderator account with the **Mod uploads** permission. If you
don't see **Mod Tools: add games** in your account menu on the site, ask the admin.

## 1. Download

Go to the [releases page](https://github.com/DragonsWho/CYOACatalog/releases/latest) and download
the file for your system:

| System | File |
|---|---|
| Windows | `cyoa-helper-windows.exe` |
| Mac with Apple chip (M1 or newer) | `cyoa-helper-macos` |
| Older Intel Mac | `cyoa-helper-macos-intel` |
| Linux | `cyoa-helper-linux` |

## 2. Start it

### Windows
- Double-click `cyoa-helper-windows.exe`. A black window with a menu opens.
- If you see "Windows protected your PC", click **More info**, then **Run anyway**. This happens
  because the program isn't signed, and it only appears the first time.

### Linux
Open a terminal and run:
```
cd ~/Downloads
chmod +x cyoa-helper-linux
./cyoa-helper-linux
```
Double-clicking the file won't work, because it needs a terminal. Always start it with
`./cyoa-helper-linux`.

### macOS
Open **Terminal** (Cmd+Space, type "Terminal") and run these commands once:
```
cd ~/Downloads
chmod +x cyoa-helper-macos
xattr -d com.apple.quarantine cyoa-helper-macos
./cyoa-helper-macos
```
- The `xattr` line stops macOS from blocking a program downloaded from the internet.
- If you downloaded the Intel version, use `cyoa-helper-macos-intel` in all three commands.
- Next time, just run `./cyoa-helper-macos` from `~/Downloads`, or double-click the file.

The helper shows a numbered menu. Type a number and press **Enter**.

## 3. Connect it to your account (first time only)

- Type `1` and press Enter. The helper shows a code like `K7QM-3XRP` and opens the Mod Tools page
  in your browser.
- Log in to cyoa.cafe if needed and press **Connect**. The helper will say "Connected as …".
- If the browser didn't open, go to your account menu → **Mod Tools: add games** and type the code
  there.
- The code works for 10 minutes. If it expires, choose `1` again.
- Next time you start the helper, it reconnects by itself.

> ⚠️ **Keep the helper window open while you work.** If you close it, the site can't download or
> upload anything.

## 4. Add a new game

Everything happens on the **Mod Tools** page.

1. Paste the game's link (neocities, github.io, itch…) and press **Download**. You can watch the
   progress on the page.
2. When it finishes, the game shows up with a label:
   - **complete** — nothing missing.
   - **check notes** — read the notes, often it's fine.
   - **broken** — don't upload it, tell the admin instead.
3. Click **▶ Play the downloaded copy** and check that the game really works. Click some choices and
   make sure the images load.
4. Press **Continue** and choose **A game that isn't on the site yet**.
   - If the site says the game may already be in the catalog, check it. Only tick **I checked:
     this is a different game** if it really is a different game.
5. **Upload to the author's address.** Find the author's account. If there's none, type the
   author's name as they sign their CYOAs and press **Create**. Check the **Game title**, **Game
   address** and **Original link**, then press **Upload**.
   - Games always go to the author's page, never to your own account.
6. **Card.** Fill in the title, authors, tags, a short description and SFW/NSFW.
   - For the cover, press **Take a screenshot**. Screenshot Studio opens; take the shot and press
     **Use as cover in Mod Tools**. Or choose an image file instead.
   - Press **Send to the publication queue**.

## 5. What happens next

Your card goes to the publication queue with an orange **🛠 MOD UPLOAD** label. **Another
moderator** has to open it, look it over and press **Looks good**. You can't approve your own
uploads. After that, the queue timer publishes it as usual.

If you have queue access, please check other people's MOD UPLOAD cards too.

## 6. Adding a translation / another version

In step 4, choose **Another language / version of a game already on the site** and paste the link
to the existing card (`cyoa.cafe/game/…`). Upload it the same way, then pick the language and, if
you like, a translated title and description. Language versions appear on the card right away,
without the queue.

## 7. Other menu options

| Key | What it does |
|---|---|
| `2` | Download a game from a link directly from the helper. |
| `3` | Import a game you already have as a **folder or .zip**. Drag it into the helper window and press Enter. The folder must contain the game's `index.html`. Afterwards, continue on the Mod Tools page. |
| `4` | Your downloaded games: play, check again, open the folder, delete. |
| `5` | Open the Mod Tools page. |
| `6` | Settings (where games are stored, disconnect). |
| `0` | Quit. |

Downloaded games are kept in the **CYOA Helper** folder in your home folder. You can delete them
after they're published, since the site keeps its own copy.

To stop using a computer, press **Disconnect** next to it on the Mod Tools page.

## 8. Problems

- **The page says the helper is offline** — the helper window is closed, or the computer went to
  sleep. Start the helper again.
- **The download failed or the game is broken** — the site may be gone, or the game may be too
  complex to download automatically. Send the link to the admin.
- **Something else** — press **Log** next to the job on the Mod Tools page and send what it says to
  the admin.

## What it will not do

- Download from web archives, or fix games that no longer exist online. Ask the admin for those.
- Replace a game that is already on hosting.
- Upload under your own account.
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
