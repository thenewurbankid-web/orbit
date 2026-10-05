# Orbit helper

A small Node.js app that runs on your computer (macOS, Windows or Linux) and shows the companies in
your local [Paperclip](https://paperclip.ing) to the Orbit website
(<https://thenewurbankid-web.github.io/orbit/>). It is also the full Orbit board at
<http://127.0.0.1:4320>. No npm dependencies; it uses the Node.js (20 or newer) that Paperclip already
needs.

## Connect this computer

1. **Paperclip** runs on the computer (at `localhost:3100`). Don't have it yet? Get it from
   <https://paperclip.ing>.
2. **Download Orbit** from the Orbit page (it picks the right file) and double-click **Start Orbit**:

   | System | Download | Open it |
   | --- | --- | --- |
   | macOS | `download/Orbit-mac.zip` | Double-click *Start Orbit*. First time: right-click → Open, or System Settings → Privacy & Security → Open Anyway. |
   | Windows | `download/Orbit-windows.zip` | Extract all, double-click *Start Orbit*. If SmartScreen appears: More info → Run anyway. |
   | Linux | `download/Orbit-linux.tar.gz` | Extract, run `start-orbit.sh` (or allow executing it in the file manager). |

   *Start Orbit* finds Node.js (on the PATH, the Node Paperclip's own launcher uses, Homebrew, nvm,
   fnm, Volta, asdf, mise, `Program Files\nodejs`), copies the helper to your user folder, starts it at
   every login, starts it now and opens the Orbit page. No admin rights, nothing outside your user
   folders.

   | System | Folder (code in `app/`, data next to it) | Starts at login via |
   | --- | --- | --- |
   | macOS | `~/Library/Application Support/Orbit` | LaunchAgent `io.github.thenewurbankid.orbit` |
   | Windows | `%LOCALAPPDATA%\Orbit` | `Orbit.vbs` in your Startup folder (runs node without a window) |
   | Linux | `~/.local/share/orbit` | `systemd --user` unit `orbit.service`, else `~/.config/autostart/orbit.desktop` |

   If Orbit already runs on the port, it is reused and nothing is installed. Advanced: the same from
   one line, `curl -fsSL https://thenewurbankid-web.github.io/orbit/install.sh | sh` (macOS, Linux) or
   `irm https://thenewurbankid-web.github.io/orbit/install.ps1 | iex` (Windows PowerShell).
3. **Connect.** On the Orbit website press **Connect to this computer**. An Orbit window opens showing a
   4-digit code; if it matches the website, press **Allow**. The browser remembers it.

Browsers: Chrome and Edge connect from the website (Private Network Access; newer versions may ask to
let the site use devices on your network: Allow). Firefox connects too (it treats `127.0.0.1` as a
secure local address; newer versions may ask the same question). Safari doesn't let websites reach
apps on the computer, so in Safari open <http://127.0.0.1:4320> instead; it's the same board.

## Control centre

Under **This computer** in Orbit's control centre: status lights (Orbit, connection, Paperclip,
login item, updates), restart, start at login on/off, check for updates (downloads the new helper files,
checks each SHA-256 against `helper/latest.json`, restarts), logs, forget this browser, and uninstall
(typed confirm; optionally deletes the folder). Uninstall is also *Uninstall Orbit* in the downloaded
folder, or `curl -fsSL https://thenewurbankid-web.github.io/orbit/uninstall.sh | sh` /
`irm https://thenewurbankid-web.github.io/orbit/uninstall.ps1 | iex`.

## Clipboard → agent

Orbit's clipboard (the vendored [pip-clipboard](../vendor/pip-clipboard/VENDOR.md) widget) sends cards to an
agent through `POST /api/clipboard/send`, behind the same access rules as everything else (this
computer's page, or the connected website with its token; other websites are refused).

`multipart/form-data`: `companyId`, optional `agentId` (default: the project's point of contact), `mode`
(`task`, or `comment` on the agent's current task), `message` (one line), repeated `link`, `text`
(≤ 8000 chars) and `file` (≤ 10, each ≤ Paperclip's `MAX_ATTACHMENT_BYTES`, 10 MB unless
`PAPERCLIP_ATTACHMENT_MAX_BYTES` says otherwise), optional `meta` JSON, and `dryRun=true` to only
describe what would happen. Files must be images (png, jpeg, gif, webp, heic), PDF, text or code (sent
as text/plain), JSON, CSV, Markdown, HTML or zip; SVG and anything else is refused. Names are cleaned
(no folders or reserved characters). Files stay in memory and go to Paperclip with
`POST /api/companies/:companyId/issues/:issueId/attachments`; links and text go into the task
description or comment; then the agent is woken. The answer names the agent, the issue and a link.

## Who can use it

- **This computer's own page** (`http://127.0.0.1:4320`, same origin): no key.
- **The Orbit website** (exactly `https://thenewurbankid-web.github.io`, plus any origins in
  `config.json` → `allowedOrigins`): only from this computer, only with a token it gets when someone
  presses Allow on `http://127.0.0.1:4320/connect` (that page also lists and removes connected
  websites). CORS and Private Network Access headers go to those exact origins only.
- **Any other website**: refused, including form posts (CSRF) and pages that reach the helper under
  another host name (DNS rebinding).
- **A phone on the same Wi-Fi**: with the access key in `token.txt`, when `host` is `0.0.0.0`.

Actions that change Paperclip (answering a question, messaging a lead, pausing work) keep their own
confirm steps in the board.

## Settings (`config.json` in the Orbit folder, optional)

| Key | Meaning |
| --- | --- |
| `companies` | Pin a list of companies. Leave it out to show every active company in Paperclip. |
| `paperclipUrl` | Another Paperclip address (default `http://localhost:3100`). |
| `host` | `127.0.0.1` (default, this computer only) or `0.0.0.0` (phones on the same Wi-Fi, with the key). |
| `repos` | Repos the question helper may read, per company prefix: `{"ABC": ["/path/to/repo"]}`. |
| `allowedOrigins` | Extra websites that may ask to connect (exact origins). |
| `intervalSec`, `alerts` | Poll interval and alert thresholds. |

Data next to it (`token.txt`, `origins.json`, `state.json`, `log.jsonl`, `eta.json`, `alerts.json`,
`orbit.log`, `web/` cache of the board page) stays on your computer.

## For maintainers

`node helper/build.mjs` builds the three downloads, `download/SHA256SUMS`, `helper/latest.json` and the
checksums in `install.sh` / `install.ps1` (`--ref` pins the installers to the current commit). Bump
`VERSION` in `helper/version.mjs` when publishing new helper files, so installed copies offer the update.
