// Builds the Orbit downloads (maintainers only; run in the orbit repo on a Mac or Linux):
//
//   node helper/build.mjs            # downloads from the current helper files, files served by the site
//   node helper/build.mjs --ref      # also pin install.sh / install.ps1 to the current commit (HEAD)
//
// Writes download/Orbit-mac.zip, download/Orbit-windows.zip, download/Orbit-linux.tar.gz,
// download/SHA256SUMS, helper/latest.json (the update check), and the checksums inside install.sh and
// install.ps1. Uses the system zip and tar. Publish flow: build, commit, push (with --ref: commit the
// downloads first, then build --ref and commit the two installers).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"]).toString().trim();
process.chdir(root);
const FILES = ["server.mjs", "chat.mjs", "helper.mjs", "access.mjs", "controls.mjs", "clipboard.mjs", "service.mjs", "setup.mjs", "version.mjs"];
const VERSION = /VERSION = "([^"]+)"/.exec(readFileSync("helper/version.mjs", "utf8"))[1];
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const L = "helper/launchers";

const README = (os) => `Orbit ${VERSION}

Orbit shows the AI companies you run in Paperclip, live, on https://thenewurbankid-web.github.io/orbit/

${os === "win" ? "Double-click \"Start Orbit\"." : os === "mac" ? "Double-click \"Start Orbit\" (the first time: right-click it and choose Open)." : "Run start-orbit.sh (or open orbit.desktop and allow launching)."}
It copies Orbit into your user folder, starts it now and at every login (no admin needed), and opens
the Orbit page. Then press "Connect to this computer" there and Allow.

To remove it: ${os === "win" ? "double-click \"Uninstall Orbit\"" : os === "mac" ? "double-click \"Uninstall Orbit\"" : "run uninstall-orbit.sh"}, or use Uninstall in Orbit's control centre.
Orbit needs Node.js 20 or newer, which Paperclip already uses.
`;

function stage(os) {
  const dir = mkdtempSync(join(tmpdir(), "orbit-build-"));
  const top = join(dir, os === "linux" ? "orbit" : "Orbit");
  mkdirSync(join(top, "helper"), { recursive: true });
  for (const f of FILES) copyFileSync(join("helper", f), join(top, "helper", f));
  if (os === "mac") {
    copyFileSync(join(L, "start-orbit.sh"), join(top, "Start Orbit.command"));
    writeFileSync(join(top, "Uninstall Orbit.command"), readFileSync(join(L, "uninstall-orbit.sh"), "utf8").replace("start-orbit.sh", "Start Orbit.command"));
    for (const f of ["Start Orbit.command", "Uninstall Orbit.command"]) chmodSync(join(top, f), 0o755);
  } else if (os === "linux") {
    for (const f of ["start-orbit.sh", "uninstall-orbit.sh", "orbit.desktop"]) { copyFileSync(join(L, f), join(top, f)); chmodSync(join(top, f), 0o755); }
  } else {
    const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
    writeFileSync(join(top, "Start Orbit.cmd"), crlf(readFileSync(join(L, "start-orbit.cmd"), "utf8")));
    writeFileSync(join(top, "Uninstall Orbit.cmd"), crlf(readFileSync(join(L, "uninstall-orbit.cmd"), "utf8")));
  }
  writeFileSync(join(top, "README.txt"), os === "win" ? README(os).replace(/\n/g, "\r\n") : README(os));
  return { dir, name: os === "linux" ? "orbit" : "Orbit" };
}

mkdirSync("download", { recursive: true });
const out = { mac: "download/Orbit-mac.zip", win: "download/Orbit-windows.zip", linux: "download/Orbit-linux.tar.gz" };
// --ref pins the installers to the archives already committed, so it must not rebuild them (zip and tar
// embed timestamps, so a rebuild never matches HEAD).
const pinOnly = process.argv.includes("--ref");
for (const [os, file] of pinOnly ? [] : Object.entries(out)) {
  const { dir, name } = stage(os);
  rmSync(file, { force: true });
  if (file.endsWith(".zip")) execFileSync("zip", ["-qrX", join(root, file), name], { cwd: dir });
  else {
    // No local user or group names in the archive.
    const anon = process.platform === "darwin" ? ["--uid", "0", "--gid", "0", "--uname", "orbit", "--gname", "orbit"] : ["--owner=0", "--group=0", "--numeric-owner"];
    execFileSync("tar", [...anon, "-czf", join(root, file), name], { cwd: dir, env: { ...process.env, COPYFILE_DISABLE: "1" } });
  }
  rmSync(dir, { recursive: true, force: true });
}
const sums = Object.fromEntries(Object.entries(out).map(([os, f]) => [os, sha(f)]));
if (!pinOnly) writeFileSync("download/SHA256SUMS", Object.values(out).map((f) => `${sha(f)}  ${f.slice("download/".length)}`).join("\n") + "\n");
if (!pinOnly) writeFileSync("helper/latest.json", JSON.stringify({ version: VERSION, files: Object.fromEntries(FILES.map((f) => [f, sha(join("helper", f))])), downloads: Object.fromEntries(Object.entries(out).map(([os, f]) => [f.slice(9), sums[os]])) }, null, 2) + "\n");

let ref = "";
if (process.argv.includes("--ref")) {
  for (const f of Object.values(out)) {
    const blob = execFileSync("git", ["show", `HEAD:${f}`]);
    if (createHash("sha256").update(blob).digest("hex") !== sha(f)) { console.error(`${f} differs from HEAD; commit the downloads first, then run --ref.`); process.exit(1); }
  }
  ref = execFileSync("git", ["rev-parse", "HEAD"]).toString().trim();
}
let sh = readFileSync("install.sh", "utf8");
sh = sh.replace(/^ORBIT_REF=".*"$/m, `ORBIT_REF="${ref}"`).replace(/^SUM_MAC=".*"$/m, `SUM_MAC="${sums.mac}"`).replace(/^SUM_LINUX=".*"$/m, `SUM_LINUX="${sums.linux}"`);
writeFileSync("install.sh", sh);
let ps = readFileSync("install.ps1", "utf8");
ps = ps.replace(/^\$OrbitRef = '.*'$/m, `$OrbitRef = '${ref}'`).replace(/^\$SumWindows = '.*'$/m, `$SumWindows = '${sums.win}'`);
writeFileSync("install.ps1", ps);
for (const [os, f] of Object.entries(out)) console.log(`${f}  ${(readFileSync(f).length / 1024).toFixed(1)} KB  ${sums[os]}`);
console.log(`helper/latest.json: version ${VERSION}; installers ${ref ? "pinned to " + ref : "use the website"}`);
