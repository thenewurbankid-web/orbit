// Where Orbit lives on this computer and how it starts at login. User-level only, no admin:
//   macOS   ~/Library/Application Support/Orbit        LaunchAgent  ~/Library/LaunchAgents/<label>.plist
//   Linux   ${XDG_DATA_HOME:-~/.local/share}/orbit      systemd --user unit, else XDG autostart .desktop
//   Windows %LOCALAPPDATA%\Orbit                        Startup-folder script (runs node hidden)
// The code goes in <base>/app, data (config, token, logs) in <base>.
//
// Test hooks (never needed in normal use): ORBIT_BASE_DIR, ORBIT_LABEL, ORBIT_PLATFORM (pretend to be
// darwin/linux/win32), ORBIT_FAKE_CMDS=<file> (record launchctl/systemctl/etc. calls instead of
// running them), ORBIT_FAKE_NO_SYSTEMD=1.
import { execFile, spawn } from "node:child_process";
import { mkdir, writeFile, rm, stat, appendFile, open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LABEL = "io.github.thenewurbankid.orbit";
export const platform = () => process.env.ORBIT_PLATFORM || process.platform;
const label = () => process.env.ORBIT_LABEL || DEFAULT_LABEL;
const home = () => process.env.HOME || process.env.USERPROFILE || homedir();

export function baseDir() {
  if (process.env.ORBIT_BASE_DIR) return process.env.ORBIT_BASE_DIR;
  const p = platform();
  if (p === "darwin") return join(home(), "Library", "Application Support", "Orbit");
  if (p === "win32") return join(process.env.LOCALAPPDATA || join(home(), "AppData", "Local"), "Orbit");
  return join(process.env.XDG_DATA_HOME || join(home(), ".local", "share"), "orbit");
}
export const appDir = () => join(baseDir(), "app");
export const logFile = () => join(baseDir(), "orbit.log");

// The files that make up the helper (copied on install and update).
export const HELPER_FILES = ["server.mjs", "chat.mjs", "helper.mjs", "access.mjs", "controls.mjs", "clipboard.mjs", "service.mjs", "setup.mjs", "version.mjs"];

function sh(cmd, args) {
  if (process.env.ORBIT_FAKE_CMDS) {
    const fake = { code: 0, stdout: "" };
    if (cmd === "systemctl" && args.includes("show-environment") && process.env.ORBIT_FAKE_NO_SYSTEMD) fake.code = 1;
    return appendFile(process.env.ORBIT_FAKE_CMDS, JSON.stringify([cmd, ...args]) + "\n").then(() => fake);
  }
  return new Promise((res) => execFile(cmd, args, { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => res({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
}
const exists = (p) => stat(p).then(() => true, () => false);
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// What the login item runs.
function launch({ node, port }) {
  // The helper needs the same view of "where am I installed" to manage its own login item later.
  const env = { BOARD_PORT: String(port), ORBIT_DATA_DIR: baseDir(), ORBIT_BASE_DIR: baseDir() };
  if (label() !== DEFAULT_LABEL) env.ORBIT_LABEL = label();
  if (platform() !== "win32") env.HOME = home();
  return { node, script: join(appDir(), "server.mjs"), env };
}

// ---------------- per platform ----------------
const mac = {
  file: () => join(home(), "Library", "LaunchAgents", `${label()}.plist`),
  async enable(opts) {
    const l = launch(opts);
    const env = { ...l.env, ORBIT_SUPERVISOR: "launchd", PATH: `${join(l.node, "..")}:/usr/bin:/bin:/usr/sbin:/sbin` };
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label())}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(l.node)}</string><string>${xml(l.script)}</string></array>
  <key>WorkingDirectory</key><string>${xml(appDir())}</string>
  <key>EnvironmentVariables</key>
  <dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(logFile())}</string>
  <key>StandardErrorPath</key><string>${xml(logFile())}</string>
</dict>
</plist>
`;
    await mkdir(join(this.file(), ".."), { recursive: true });
    await writeFile(this.file(), plist);
    if (opts.start) {
      const uid = String(process.getuid?.() ?? 501);
      await sh("launchctl", ["bootout", `gui/${uid}/${label()}`]);
      // bootout finishes asynchronously; bootstrap right after it can fail with error 5, so retry.
      let r;
      for (let i = 0; i < 10; i++) { r = await sh("launchctl", ["bootstrap", `gui/${uid}`, this.file()]); if (r.code === 0) break; await new Promise((ok) => setTimeout(ok, 500)); }
      if (r.code !== 0) throw new Error("macOS didn't start Orbit (launchctl " + r.code + ")");
    }
    return { kind: "LaunchAgent", where: this.file(), supervised: true };
  },
  async disable({ stop }) {
    await rm(this.file(), { force: true });
    if (stop) await sh("launchctl", ["bootout", `gui/${String(process.getuid?.() ?? 501)}/${label()}`]);
  },
  status: async () => ({ on: await exists(mac.file()), kind: "LaunchAgent", where: mac.file() }),
};

const unitName = () => (label() === DEFAULT_LABEL ? "orbit" : label());
const linux = {
  unit: () => join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "systemd", "user", `${unitName()}.service`),
  desktop: () => join(process.env.XDG_CONFIG_HOME || join(home(), ".config"), "autostart", `${unitName()}.desktop`),
  hasSystemd: async () => (await sh("systemctl", ["--user", "show-environment"])).code === 0,
  async enable(opts) {
    const l = launch(opts);
    const q = (s) => `"${String(s).replace(/(["\\])/g, "\\$1")}"`;
    if (await this.hasSystemd()) {
      const env = { ...l.env, ORBIT_SUPERVISOR: "systemd" };
      await mkdir(join(this.unit(), ".."), { recursive: true });
      await writeFile(this.unit(), `[Unit]
Description=Orbit helper (shows your Paperclip companies on the Orbit website)
After=network.target

[Service]
ExecStart=${q(l.node)} ${q(l.script)}
WorkingDirectory=${appDir()}
${Object.entries(env).map(([k, v]) => `Environment=${q(`${k}=${v}`)}`).join("\n")}
Restart=on-failure
RestartSec=3
StandardOutput=append:${logFile()}
StandardError=append:${logFile()}

[Install]
WantedBy=default.target
`);
      await sh("systemctl", ["--user", "daemon-reload"]);
      const r = await sh("systemctl", ["--user", opts.start ? "enable" : "enable", ...(opts.start ? ["--now"] : []), `${unitName()}.service`]);
      if (opts.start && r.code === 0) await sh("systemctl", ["--user", "restart", `${unitName()}.service`]);
      if (r.code !== 0) throw new Error("systemd didn't start Orbit");
      return { kind: "systemd user service", where: this.unit(), supervised: true };
    }
    // No systemd user session: an autostart entry for the desktop, and start it now ourselves.
    await mkdir(join(this.desktop(), ".."), { recursive: true });
    const envs = Object.entries(l.env).map(([k, v]) => `${k}=${q(v)}`).join(" ");
    await writeFile(this.desktop(), `[Desktop Entry]
Type=Application
Name=Orbit helper
Comment=Shows your Paperclip companies on the Orbit website
Exec=env ${envs} ${q(l.node)} ${q(l.script)}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`);
    if (opts.start) await startDetached(opts);
    return { kind: "autostart entry", where: this.desktop(), supervised: false };
  },
  async disable({ stop }) {
    if (await exists(this.unit())) {
      await sh("systemctl", ["--user", "disable", ...(stop ? ["--now"] : []), `${unitName()}.service`]);
      await rm(this.unit(), { force: true });
      await sh("systemctl", ["--user", "daemon-reload"]);
    }
    await rm(this.desktop(), { force: true });
  },
  async status() {
    if (await exists(linux.unit())) return { on: true, kind: "systemd user service", where: linux.unit() };
    return { on: await exists(linux.desktop()), kind: "autostart entry", where: linux.desktop() };
  },
};

const win = {
  // A tiny script in the Startup folder runs node with no window at every login (no admin needed).
  file: () => join(process.env.APPDATA || join(home(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${label() === DEFAULT_LABEL ? "Orbit" : label()}.vbs`),
  async enable(opts) {
    const l = launch(opts);
    const vq = (s) => `""${String(s).replace(/"/g, "")}""`;
    const lines = [
      "' Starts the Orbit helper at login, without a window. Remove this file to stop that.",
      'Set sh = CreateObject("WScript.Shell")',
      'Set env = sh.Environment("Process")',
      ...Object.entries(l.env).map(([k, v]) => `env("${k}") = "${String(v).replace(/"/g, "")}"`),
      `sh.CurrentDirectory = "${appDir().replace(/"/g, "")}"`,
      `sh.Run "${vq(l.node)} ${vq(l.script)}", 0, False`,
    ];
    await mkdir(join(this.file(), ".."), { recursive: true });
    await writeFile(this.file(), lines.join("\r\n") + "\r\n");
    if (opts.start) await startDetached(opts);
    return { kind: "Startup folder", where: this.file(), supervised: false };
  },
  async disable() { await rm(this.file(), { force: true }); },
  status: async () => ({ on: await exists(win.file()), kind: "Startup folder", where: win.file() }),
};

const impl = () => ({ darwin: mac, win32: win }[platform()] ?? linux);
export const autostart = {
  enable: (opts) => impl().enable(opts),           // opts: {node, port, start}
  disable: (opts = {}) => impl().disable(opts),    // opts: {stop}
  status: () => impl().status(),
};

// Start the helper now, outside any supervisor (Windows, Linux without systemd, restarts).
export async function startDetached({ node, port, extraEnv = {} }) {
  const l = launch({ node, port });
  if (process.env.ORBIT_FAKE_CMDS && !process.env.ORBIT_REAL_START) { await appendFile(process.env.ORBIT_FAKE_CMDS, JSON.stringify(["start", l.node, l.script]) + "\n"); return; }
  await mkdir(baseDir(), { recursive: true });
  const out = await open(logFile(), "a");
  const child = spawn(l.node, [l.script], { cwd: appDir(), env: { ...process.env, ...l.env, ...extraEnv, ORBIT_SUPERVISOR: "" }, detached: true, stdio: ["ignore", out.fd, out.fd], windowsHide: true });
  child.unref();
  await out.close();
}

// Open a web page in the default browser.
export function openUrl(url) {
  if (process.env.ORBIT_NO_OPEN) return;
  const p = platform();
  const [cmd, args] = p === "darwin" ? ["open", [url]] : p === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try { spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref(); } catch { /* the page link is printed too */ }
}
