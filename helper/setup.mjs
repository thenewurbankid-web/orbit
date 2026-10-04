// First run of the downloaded Orbit helper (started by "Start Orbit" or the one-line installer):
// copies the helper to this user's app-data folder, starts it at login, starts it now, opens the
// Orbit page. User-level only; no admin. Also: `node setup.mjs uninstall [--delete-data]`.
import { copyFile, mkdir, writeFile, readFile, rm, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";
import { VERSION, SITE } from "./version.mjs";
import { baseDir, appDir, autostart, startDetached, openUrl, HELPER_FILES, platform } from "./service.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ORBIT_PORT || process.env.BOARD_PORT || 4320);
const say = (s = "") => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageUrl = () => SITE + (PORT === 4320 ? "" : `?macport=${PORT}`);

async function health() {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2500) }); return r.ok ? await r.json() : { status: r.status }; } catch { return null; }
}
// Something listening on the port at all? (no lsof: works the same on every OS)
const portBusy = () => new Promise((res) => { const s = createConnection({ host: "127.0.0.1", port: PORT }); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); s.setTimeout(1500, () => { s.destroy(); res(false); }); });
async function installedVersion() { try { return JSON.parse(await readFile(join(appDir(), ".orbit-installed"), "utf8")).version; } catch { return null; } }

async function install() {
  say("Orbit helper");
  say("------------");
  const [major] = process.versions.node.split(".").map(Number);
  if (major < 20) { say(`Orbit needs Node.js 20 or newer (this computer has ${process.version}). Get the current one from https://nodejs.org, then start Orbit again.`); return 1; }
  const h = await health();
  const mine = await installedVersion();
  if (h?.app === "orbit" && !mine) {
    say("✓ Orbit is already running on this computer. Nothing to install.");
    openUrl(pageUrl());
    say(""); say("Done, go back to the Orbit page. You can close this window.");
    return 0;
  }
  if (!h?.app && await portBusy()) {
    say(`Another program is using port ${PORT}, so Orbit can't start there. Nothing was changed.`);
    say("If that is an older Orbit board you started yourself, keep using it, or stop it and start Orbit again.");
    return 1;
  }
  // Copy the helper in (a newer download replaces the code; settings and data stay).
  await mkdir(appDir(), { recursive: true });
  for (const f of HELPER_FILES) {
    const tmp = join(appDir(), f + ".new");
    await copyFile(join(here, f), tmp);
    await rename(tmp, join(appDir(), f));
  }
  await writeFile(join(appDir(), ".orbit-installed"), JSON.stringify({ version: VERSION, at: new Date().toISOString(), node: process.execPath }, null, 2) + "\n");
  say(`✓ Orbit ${VERSION} is in ${baseDir()}`);
  // Start at login, and now. A copy of ours that is already running is reloaded on the new files:
  // through its login item where that supervises it, else by asking it to restart.
  const running = h?.app === "orbit" && Boolean(mine);
  let how = await autostart.enable({ node: process.execPath, port: PORT, start: false });
  if (running && !how.supervised) {
    try { await fetch(`http://127.0.0.1:${PORT}/api/helper/restart`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` }, body: "{}" }); } catch {}
    await sleep(1500);
  } else how = await autostart.enable({ node: process.execPath, port: PORT, start: true });
  say(`✓ Starts by itself when you log in (${how.kind})`);
  if (process.env.ORBIT_SETUP_NO_WAIT) { say("(test run: not waiting for it)"); return 0; }
  let up = null;
  for (let i = 0; i < 40 && !(up?.app === "orbit"); i++) { await sleep(500); up = await health(); }
  if (up?.app !== "orbit") {
    if (!how.supervised) await startDetached({ node: process.execPath, port: PORT });
    for (let i = 0; i < 20 && !(up?.app === "orbit"); i++) { await sleep(500); up = await health(); }
  }
  if (up?.app !== "orbit") { say(`Orbit didn't start. Details are in ${join(baseDir(), "orbit.log")}.`); return 1; }
  say(`✓ Orbit is running at http://127.0.0.1:${PORT}`);
  if (!up.paperclip) say("Note: Paperclip isn't running right now. Orbit shows your companies as soon as it is.");
  openUrl(pageUrl());
  say("");
  say("Done, go back to the Orbit page. Orbit is running, you can close this window.");
  return 0;
}

async function uninstall(deleteData) {
  await autostart.disable({ stop: true });
  // Unsupervised copies (Windows, no systemd) stop when asked.
  try { await fetch(`http://127.0.0.1:${PORT}/api/helper/uninstall`, { method: "POST", headers: { "content-type": "application/json", origin: `http://127.0.0.1:${PORT}` }, body: JSON.stringify({ confirm: "uninstall", keepAutostartRemoved: true }) }); } catch {}
  say("✓ Orbit is stopped and won't start at login any more.");
  if (deleteData) { await rm(baseDir(), { recursive: true, force: true }); say(`✓ Removed ${baseDir()}`); }
  else say(`Your Orbit folder (settings and history) is still at ${baseDir()}. Delete it if you don't need it.`);
  say("Done.");
  return 0;
}

// Always run as a program (nothing imports this file).
const cmd = process.argv[2] ?? "install";
let code;
try { code = cmd === "uninstall" ? await uninstall(process.argv.includes("--delete-data")) : await install(); }
catch (e) { say(""); say(`Something went wrong: ${e.message}`); say("Nothing else was changed. Try Start Orbit again; if it keeps happening, restart the computer and try once more."); code = 1; }
process.exit(code);
