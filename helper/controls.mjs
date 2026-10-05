// Helper controls for the control centre (settings panel): status, restart, auto-start, update,
// uninstall, forget all connected websites. Reached only by this computer's own page or a website
// that was allowed (see access.mjs); the page asks the person to confirm each action.
import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { open, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { autostart, baseDir, appDir, HELPER_FILES, logFile, platform, DEFAULT_LABEL } from "./service.mjs";

const started = Date.now();
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const newer = (a, b) => { const x = String(a).split(".").map(Number), y = String(b).split(".").map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
const fail = (status, message) => Object.assign(new Error(message), { status });

async function tail(path, lines = 120) {
  try {
    const fh = await open(path, "r");
    const { size } = await fh.stat();
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len); await fh.close();
    return buf.toString("utf8").split(/\r?\n/).slice(-lines);
  } catch { return []; }
}

export function createControls({ port, here, dataDir, version, site, paperclipUp, access, onExit }) {
  // An installed copy lives in <base>/app with a marker; a copy run by hand from a folder (a developer
  // checkout) can be watched and restarted but not updated, uninstalled or given a login item here.
  const installed = () => stat(join(here, ".orbit-installed")).then(() => true, () => false);
  const supervisor = () => process.env.ORBIT_SUPERVISOR || null;

  async function logLines() {
    const files = (await installed()) ? [logFile()] : [join(dataDir, "service.log"), join(dataDir, "service.err.log"), logFile()];
    const out = [];
    for (const f of files) out.push(...await tail(f));
    return out.slice(-150).map((l) => l.replace(/([?&]key=)[0-9a-f]+/gi, "$1…")); // never show the access key
  }

  async function status() {
    const inst = await installed();
    return {
      version, port, pid: process.pid, uptimeSec: Math.round((Date.now() - started) / 1000),
      platform: platform(), node: { version: process.version, path: process.execPath },
      dataDir, codeDir: here, installed: inst, supervisor: supervisor(),
      autostart: inst ? await autostart.status() : { on: null, kind: "set up by hand", where: null },
      paperclip: await paperclipUp(),
      connectedSites: access().sites().length,
      log: await logLines(),
    };
  }

  // Restart: a login item that restarts on failure gets a non-zero exit; otherwise start a copy that
  // waits for the port, then exit.
  function restartSoon() {
    setTimeout(async () => {
      if (supervisor()) { onExit?.(); process.exit(75); }
      const out = await open(join(dataDir, (await installed()) ? "orbit.log" : "service.log"), "a").catch(() => null);
      const child = spawn(process.execPath, process.argv.slice(1), { cwd: process.cwd(), env: { ...process.env, ORBIT_WAIT_PORT: "1" }, detached: true, stdio: ["ignore", out?.fd ?? "ignore", out?.fd ?? "ignore"], windowsHide: true });
      child.unref(); await out?.close();
      onExit?.(); process.exit(0);
    }, 400);
  }

  async function latest() {
    const r = await fetch(new URL("helper/latest.json", site()), { signal: AbortSignal.timeout(15000), cache: "no-store" });
    if (!r.ok) throw fail(502, "Couldn't reach the Orbit website to check for updates.");
    return r.json();
  }

  const routes = {
    async "/api/helper/restart"() { restartSoon(); return { ok: true, restarting: true }; },
    async "/api/helper/autostart"(b) {
      if (!await installed()) throw fail(400, "This copy of Orbit was started by hand, so its login item isn't managed here.");
      if (b.on === true) await autostart.enable({ node: process.execPath, port, start: false });
      else if (b.on === false) await autostart.disable({ stop: false });
      else throw fail(400, "on must be true or false");
      return { ok: true, autostart: await autostart.status() };
    },
    async "/api/helper/update"(b) {
      const l = await latest();
      // Also "available" when a helper file is missing here (an older copy updated without it).
      const missing = [];
      for (const n of HELPER_FILES) if (l.files?.[n] && !(await stat(join(here, n)).then(() => true, () => false))) missing.push(n);
      const available = newer(l.version, version) || missing.length > 0;
      if (!b.apply) return { current: version, latest: l.version, available, notes: l.notes ?? null };
      if (!available) return { ok: true, current: version, latest: l.version, available: false };
      if (!await installed()) throw fail(400, "This copy of Orbit was started by hand; update it where it came from.");
      const names = Object.keys(l.files ?? {}).filter((n) => HELPER_FILES.includes(n));
      if (!names.includes("server.mjs")) throw fail(502, "The update list looks wrong; nothing was changed.");
      const got = {};
      for (const n of names) {
        const r = await fetch(new URL(`helper/${n}`, site()), { signal: AbortSignal.timeout(30000), cache: "no-store" });
        if (!r.ok) throw fail(502, `Couldn't download ${n}; nothing was changed.`);
        const buf = Buffer.from(await r.arrayBuffer());
        if (sha(buf) !== l.files[n]) throw fail(502, `${n} didn't match its checksum; nothing was changed.`);
        got[n] = buf;
      }
      for (const n of names) await writeFile(join(here, n + ".new"), got[n]);
      for (const n of names) await rename(join(here, n + ".new"), join(here, n));
      const marker = join(here, ".orbit-installed");
      const m = JSON.parse(await readFile(marker, "utf8").catch(() => "{}"));
      await writeFile(marker, JSON.stringify({ ...m, version: l.version, updatedAt: new Date().toISOString() }, null, 2) + "\n");
      restartSoon();
      return { ok: true, updatedTo: l.version, restarting: true };
    },
    async "/api/helper/uninstall"(b) {
      if (b.confirm !== "uninstall") throw fail(400, 'Type "uninstall" to confirm.');
      if (!await installed()) throw fail(400, "This copy of Orbit was started by hand, so it can't uninstall itself here.");
      await autostart.disable({ stop: false });
      const deleteData = b.deleteData === true;
      setTimeout(async () => {
        onExit?.();
        if (deleteData) await rm(baseDir(), { recursive: true, force: true }).catch(() => {});
        // A LaunchAgent is still loaded for this session: unload it (that also ends this process).
        if (supervisor() === "launchd" && !process.env.ORBIT_FAKE_CMDS) execFile("launchctl", ["bootout", `gui/${process.getuid()}/${process.env.ORBIT_LABEL || DEFAULT_LABEL}`], () => process.exit(0));
        else process.exit(0);
      }, 400);
      return { ok: true, stopped: true, deletedData: deleteData, dataDir: deleteData ? null : baseDir() };
    },
    async "/api/helper/reset-pairing"(b) {
      if (b.confirm !== "reset") throw fail(400, "Confirm with reset.");
      await access().resetSites();
      return { ok: true };
    },
  };

  return {
    status,
    handles: (p) => Object.hasOwn(routes, p),
    act: (p, body) => routes[p](body ?? {}),
  };
}
