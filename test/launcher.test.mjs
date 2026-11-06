import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installApp, removeApp, launchScript, buildIcns, parseGsettingsList, paths } from "../src/launcher.mjs";

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoroute-app-"));
  const env = { HOME: root, XDG_DATA_HOME: path.join(root, "share"), PATH: process.env.PATH };
  const home = path.join(root, ".claude-autoroute"); fs.mkdirSync(home);
  return { root, env, home };
}

test("the launch script runs `autoroute ui` through the login shell", { skip: process.platform === "win32" }, () => {
  const { root } = sandbox();
  const out = path.join(root, "args.txt");
  const fakeNode = path.join(root, "fake node's dir", "node");
  fs.mkdirSync(path.dirname(fakeNode));
  fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(out)}\n`, { mode: 0o755 });
  const cliPath = path.join(root, "it's here", "autoroute.mjs");
  fs.mkdirSync(path.dirname(cliPath)); fs.writeFileSync(cliPath, "");
  const script = path.join(root, "open-dashboard");
  fs.writeFileSync(script, launchScript({ node: fakeNode, cli: cliPath }), { mode: 0o700 });
  const r = spawnSync(script, { env: { HOME: root, SHELL: "/bin/sh", PATH: process.env.PATH } });
  assert.equal(r.status, 0);
  assert.deepEqual(fs.readFileSync(out, "utf8").trim().split("\n"), [cliPath, "ui"], "paths with spaces and quotes survive");
});

test("the launch script fails cleanly if Node.js moved", { skip: process.platform === "win32" }, () => {
  const { root } = sandbox();
  const script = path.join(root, "open-dashboard");
  fs.writeFileSync(script, launchScript({ node: "/nonexistent/node", cli: "/nonexistent/cli" }), { mode: 0o700 });
  const r = spawnSync(script, { env: { HOME: root, PATH: "/usr/bin:/bin" } });
  assert.equal(r.status, 1);
});

test("Linux: desktop entry and icons in the standard places", () => {
  const { env, home } = sandbox();
  const r = installApp({ home, env, platform: "linux", reveal: false });
  assert.equal(r.ok, true);
  const p = paths(env);
  const entry = fs.readFileSync(p.desktop, "utf8");
  assert.match(entry, /^\[Desktop Entry\]/);
  assert.match(entry, /^Type=Application$/m);
  assert.match(entry, /^Icon=autoroute$/m);
  assert.match(entry, new RegExp(`^Exec="${path.join(home, "open-dashboard").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"));
  assert.ok(fs.existsSync(p.iconPng) && fs.existsSync(p.iconSvg));
  assert.equal(fs.statSync(path.join(home, "open-dashboard")).mode & 0o777, 0o700);
  removeApp({ home, env, platform: "linux" });
  assert.ok(!fs.existsSync(p.desktop) && !fs.existsSync(p.iconPng));
});

test("macOS: a valid app bundle with an icon, without Apple tools", () => {
  const { env, home } = sandbox();
  const r = installApp({ home, env, platform: "darwin", reveal: false });
  assert.equal(r.ok, true);
  const app = paths(env).macApp;
  const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
  assert.match(plist, /<key>CFBundleExecutable<\/key><string>open-dashboard<\/string>/);
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>AppIcon<\/string>/);
  assert.equal(fs.statSync(path.join(app, "Contents", "MacOS", "open-dashboard")).mode & 0o111, 0o111);
  const icns = fs.readFileSync(path.join(app, "Contents", "Resources", "AppIcon.icns"));
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
  const types = [];
  for (let off = 8; off < icns.length;) {
    const type = icns.toString("ascii", off, off + 4), len = icns.readUInt32BE(off + 4);
    assert.equal(icns.subarray(off + 8, off + 16).toString("hex"), "89504e470d0a1a0a", `${type} holds a PNG`);
    types.push(type); off += len;
  }
  assert.deepEqual(types.sort(), ["ic07", "ic08", "ic09", "ic10"]);
  removeApp({ home, env, platform: "darwin" });
  assert.ok(!fs.existsSync(app));
});

test("GNOME favorites parsing", () => {
  assert.deepEqual(parseGsettingsList("@as []"), []);
  assert.deepEqual(parseGsettingsList("['firefox.desktop', 'org.gnome.Nautilus.desktop']"), ["firefox.desktop", "org.gnome.Nautilus.desktop"]);
});

test("icns builder sizes add up", () => {
  const { root } = sandbox();
  const f = path.join(root, "x.png"); fs.writeFileSync(f, Buffer.from("89504e470d0a1a0a00", "hex"));
  const b = buildIcns({ 256: f });
  assert.equal(b.length, 8 + 8 + 9);
});
