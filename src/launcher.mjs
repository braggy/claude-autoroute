// "App icon" launchers for the dashboard, using each desktop's native format:
//   macOS: ~/Applications/autoroute.app  (shows in Launchpad/Spotlight; drag to the Dock)
//   Linux: ~/.local/share/applications/autoroute-dashboard.desktop + hicolor icons
//          (shows in the app grid; optional pin to the GNOME dock)
// Both run the same small script, which runs `autoroute ui` through your login shell
// so the router sees the same environment variables as your terminal.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { ROOT, onPath } from "./util.mjs";

const APP_NAME = "autoroute";
const DESKTOP_ID = "autoroute-dashboard.desktop";
const BUNDLE_ID = "local.autoroute.dashboard";
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // POSIX single-quote
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

export function paths(env = process.env, home = os.homedir()) {
  const h = env.HOME || home;
  const data = env.XDG_DATA_HOME || path.join(h, ".local", "share");
  return {
    macApp: path.join(h, "Applications", `${APP_NAME}.app`),
    desktop: path.join(data, "applications", DESKTOP_ID),
    iconPng: path.join(data, "icons", "hicolor", "256x256", "apps", `${APP_NAME}.png`),
    iconSvg: path.join(data, "icons", "hicolor", "scalable", "apps", `${APP_NAME}.svg`),
  };
}

// --------------------------------------------------------------- script ---
export function launchScript({ node = process.execPath, cli = path.join(ROOT, "bin", "autoroute.mjs"), autorouteHome } = {}) {
  return `#!/bin/sh
# Opens the autoroute dashboard. Created by \`autoroute app install\`; safe to delete
# (\`autoroute app remove\` does it for you).
NODE=${sq(node)}
CLI=${sq(cli)}
${autorouteHome ? `export AUTOROUTE_HOME=${sq(autorouteHome)}\n` : ""}
fail() {
  MSG="autoroute couldn't start: $1. Run 'autoroute app install' again from a terminal."
  if command -v osascript >/dev/null 2>&1; then osascript -e "display alert \\"autoroute\\" message \\"$MSG\\"" >/dev/null 2>&1
  elif command -v notify-send >/dev/null 2>&1; then notify-send "autoroute" "$MSG"
  fi
  exit 1
}
[ -x "$NODE" ] || fail "Node.js is no longer at $NODE"
[ -f "$CLI" ] || fail "autoroute is no longer installed at $CLI"

# Use your login shell, so environment variables you set for your terminal are seen too.
SH="\${SHELL:-/bin/sh}"
case "$(basename "$SH")" in sh|bash|zsh|dash|ksh) ;; *) SH=/bin/sh ;; esac
# Single quotes on purpose: the login shell expands $0/$1, so paths are never re-parsed.
# shellcheck disable=SC2016
exec "$SH" -l -c 'exec "$0" "$1" ui' "$NODE" "$CLI" </dev/null >/dev/null 2>&1
`;
}

// ----------------------------------------------------------------- icns ---
// Minimal .icns writer: modern macOS accepts PNG payloads, so no Apple tools are needed.
export function buildIcns(pngs) {
  const types = { 1024: "ic10", 512: "ic09", 256: "ic08", 128: "ic07" };
  const chunks = [];
  for (const [size, file] of Object.entries(pngs)) {
    const data = fs.readFileSync(file);
    const head = Buffer.alloc(8);
    head.write(types[size], 0, "ascii");
    head.writeUInt32BE(data.length + 8, 4);
    chunks.push(head, data);
  }
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const asset = (n) => path.join(ROOT, "assets", n);

function writeMacApp(app, script) {
  fs.rmSync(app, { recursive: true, force: true });
  const contents = path.join(app, "Contents");
  fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
  fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
  fs.writeFileSync(path.join(contents, "MacOS", "open-dashboard"), script, { mode: 0o755 });
  fs.writeFileSync(path.join(contents, "Resources", "AppIcon.icns"),
    buildIcns({ 1024: asset("icon-1024.png"), 512: asset("icon-512.png"), 256: asset("icon-256.png"), 128: asset("icon-128.png") }));
  fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${xmlEsc(APP_NAME)}</string>
  <key>CFBundleDisplayName</key><string>${xmlEsc(APP_NAME)}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>open-dashboard</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
`);
}

function desktopFile(scriptPath) {
  const q = (s) => `"${String(s).replace(/(["`$\\])/g, "\\$1")}"`;
  return `[Desktop Entry]
Type=Application
Name=autoroute
GenericName=Claude Code router
Comment=Open the autoroute dashboard: savings, providers and settings
Exec=${q(scriptPath)}
Icon=${APP_NAME}
Terminal=false
StartupNotify=false
Categories=Development;
Keywords=claude;router;llm;dashboard;
`;
}

// ------------------------------------------------------------ GNOME dock ---
export function parseGsettingsList(text) {
  const t = String(text).trim();
  if (!t || t.startsWith("@as")) return [];
  return [...t.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]);
}
const gsettingsList = (items) => "[" + items.map((i) => `'${i}'`).join(", ") + "]";

function gnomeFavorites(update) {
  if (!onPath("gsettings")) return { ok: false, message: "gsettings not found; pin it from the app grid instead (right-click > Pin to Dash / Add to Favorites)" };
  try {
    const cur = parseGsettingsList(execFileSync("gsettings", ["get", "org.gnome.shell", "favorite-apps"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
    const next = update(cur);
    if (next === cur) return { ok: true, message: "already in the dock" };
    execFileSync("gsettings", ["set", "org.gnome.shell", "favorite-apps", gsettingsList(next)], { stdio: "ignore" });
    return { ok: true, message: "updated the dock" };
  } catch {
    return { ok: false, message: "this desktop doesn't use GNOME's dock settings; pin it from the app menu instead" };
  }
}

// ------------------------------------------------------------- install ---
export function appState(env = process.env) {
  const p = paths(env);
  if (process.platform === "darwin") return fs.existsSync(p.macApp) ? "installed" : "none";
  if (process.platform === "linux") return fs.existsSync(p.desktop) ? "installed" : "none";
  return "unsupported";
}

/** Returns { ok, location, messages[] }. */
export function installApp({ home, env = process.env, dock = false, reveal = true, platform = process.platform } = {}) {
  const p = paths(env);
  const scriptPath = path.join(home, "open-dashboard");
  const script = launchScript({ autorouteHome: env.AUTOROUTE_HOME });
  fs.writeFileSync(scriptPath, script, { mode: 0o700 });
  fs.chmodSync(scriptPath, 0o700);
  const messages = [];

  if (platform === "darwin") {
    writeMacApp(p.macApp, script);
    messages.push(`Created ${p.macApp}. Find it in Launchpad or Spotlight as "autoroute".`);
    messages.push("To add it to the Dock: drag it from the Finder window that just opened onto the Dock.");
    if (dock) messages.push("(macOS doesn't offer a safe way for apps to edit your Dock, so this step is a drag.)");
    if (reveal) spawn("open", ["-R", p.macApp], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
    return { ok: true, location: p.macApp, messages };
  }
  if (platform === "linux") {
    for (const f of [p.desktop, p.iconPng, p.iconSvg]) fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.copyFileSync(asset("icon-256.png"), p.iconPng);
    fs.copyFileSync(asset("icon.svg"), p.iconSvg);
    fs.writeFileSync(p.desktop, desktopFile(scriptPath), { mode: 0o644 });
    for (const [cmd, args] of [["update-desktop-database", [path.dirname(p.desktop)]], ["gtk-update-icon-cache", ["-q", "-t", path.join(path.dirname(path.dirname(path.dirname(p.iconPng))))]]]) {
      if (onPath(cmd)) { try { execFileSync(cmd, args, { stdio: "ignore" }); } catch {} }
    }
    messages.push(`Created ${p.desktop}. Find "autoroute" in your app grid or menu.`);
    if (dock) {
      const r = gnomeFavorites((cur) => (cur.includes(DESKTOP_ID) ? cur : [...cur, DESKTOP_ID]));
      messages.push(r.ok ? `Pinned to the dock (${r.message}).` : `Couldn't pin automatically: ${r.message}.`);
    } else {
      messages.push("To pin it to the dock: right-click it in the app grid > Pin to Dash, or run: autoroute app install --dock");
    }
    return { ok: true, location: p.desktop, messages };
  }
  return { ok: false, messages: ["App icons are supported on macOS and Linux desktops."] };
}

export function removeApp({ home, env = process.env, platform = process.platform } = {}) {
  const p = paths(env);
  const removed = [];
  for (const f of [p.macApp, p.desktop, p.iconPng, p.iconSvg, path.join(home, "open-dashboard")]) {
    if (fs.existsSync(f)) { fs.rmSync(f, { recursive: true, force: true }); removed.push(f); }
  }
  const messages = removed.length ? [`Removed ${removed.length} file(s).`] : ["Nothing to remove."];
  if (platform === "linux") {
    const r = gnomeFavorites((cur) => (cur.includes(DESKTOP_ID) ? cur.filter((x) => x !== DESKTOP_ID) : cur));
    if (r.ok && r.message !== "already in the dock") messages.push("Unpinned from the dock.");
  }
  if (platform === "darwin" && removed.length) messages.push("If it was in your Dock, drag it off (macOS shows a question mark for removed apps).");
  return { ok: true, messages };
}

export { SHELLS };
