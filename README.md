# Orbit

A live sky view of the AI companies you run in [Paperclip](https://paperclip.ing). Projects are
planets, agents are moons, issues are satellites.

## Connect your Mac

1. Paperclip runs on your Mac.
2. Install the small Orbit helper: open Terminal (⌘ Space, type Terminal, Return), paste this line and
   press Return:

   ```sh
   curl -fsSL https://thenewurbankid-web.github.io/orbit/install.sh | sh
   ```

3. Back on the site, press **Connect to this Mac** and then **Allow** in the Orbit window on your Mac.

In Safari, open <http://127.0.0.1:4320> on the Mac instead (same board). Details, security and
uninstalling: [helper/README.md](helper/README.md).

## Phone

Open the board on the Mac, tap **pair phone** and scan the QR code. The phone connects directly to
the Mac's page over WebRTC; the phone page makes no server calls of its own and stores nothing secret.

The site is static and works from any host; all paths are relative. Libraries load from jsDelivr
(three.js) and cdnjs (qrcodejs, Mac side only).
