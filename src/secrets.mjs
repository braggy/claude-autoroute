// API keys in the operating system's secure storage, with one interface on both platforms:
//   macOS: Keychain, via /usr/bin/security (built in)
//   Linux: Secret Service (GNOME Keyring, KWallet...), via `secret-tool` (package libsecret-tools)
// Secrets are passed to these tools on stdin, never as command-line arguments
// (which other users could see in `ps`). There is deliberately no plaintext fallback.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { onPath } from "./util.mjs";

export const SERVICE = "claude-autoroute";
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

function run(cmd, args, input, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => { clearTimeout(t); resolve({ code: -1, out, err: e.message }); });
    child.on("close", (code) => { clearTimeout(t); resolve({ code, out, err }); });
    child.stdin.end(input ?? "");
  });
}

// Quote a value for `security -i` (it tokenizes its stdin like a shell line).
export function securityQuote(v) {
  if (/[\r\n\0]/.test(v)) throw new Error("secrets cannot contain line breaks");
  return '"' + v.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

const macos = {
  name: "macOS Keychain",
  available: () => process.platform === "darwin" && fs.existsSync("/usr/bin/security"),
  async set(name, value) {
    const line = `add-generic-password -U -s ${securityQuote(SERVICE)} -a ${securityQuote(name)} -l ${securityQuote(`${SERVICE}: ${name}`)} -w ${securityQuote(value)}\n`;
    const r = await run("/usr/bin/security", ["-i"], line);
    if (r.code !== 0 || /error|fail/i.test(r.err)) throw new Error(`Keychain refused the key: ${r.err.trim() || "exit " + r.code}`);
  },
  async get(name) {
    const r = await run("/usr/bin/security", ["find-generic-password", "-s", SERVICE, "-a", name, "-w"]);
    return r.code === 0 ? r.out.replace(/\n$/, "") : null;
  },
  async remove(name) { await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", name]); },
};

const linux = {
  name: "Secret Service (GNOME Keyring / KWallet)",
  available: () => process.platform === "linux" && !!onPath("secret-tool"),
  async set(name, value) {
    const r = await run("secret-tool", ["store", `--label=${SERVICE}: ${name}`, "service", SERVICE, "account", name], value);
    if (r.code !== 0) throw new Error(`Secret Service refused the key: ${r.err.trim() || "exit " + r.code}. Is a keyring unlocked in this session?`);
  },
  async get(name) {
    const r = await run("secret-tool", ["lookup", "service", SERVICE, "account", name]);
    return r.code === 0 && r.out ? r.out.replace(/\n$/, "") : null;
  },
  async remove(name) { await run("secret-tool", ["clear", "service", SERVICE, "account", name]); },
};

let override = null; // tests can inject a backend
export function setBackendForTests(b) { override = b; }

export function backend() {
  if (override) return override;
  if (macos.available()) return macos;
  if (linux.available()) return linux;
  return null;
}

export function backendInfo() {
  const b = backend();
  if (b) return { available: true, name: b.name };
  return {
    available: false,
    name: null,
    help: process.platform === "linux"
      ? "Install secret-tool (Debian/Ubuntu: sudo apt install libsecret-tools; Fedora: sudo dnf install libsecret) and make sure a keyring is unlocked, or use an environment variable instead."
      : "No supported secure storage found. Use an environment variable instead.",
  };
}

function check(name) {
  if (!NAME_RE.test(name || "")) throw new Error("key names may only use letters, numbers, dot, dash and underscore");
}

export async function setSecret(name, value) {
  check(name);
  if (!value || typeof value !== "string") throw new Error("empty key");
  const b = backend();
  if (!b) throw new Error(backendInfo().help);
  await b.set(name, value.trim());
}
export async function getSecret(name) {
  check(name);
  const b = backend();
  if (!b) throw new Error(`can't read keychain entry "${name}": ${backendInfo().help}`);
  const v = await b.get(name);
  if (!v) throw new Error(`no key named "${name}" in ${b.name}`);
  return v;
}
export async function hasSecret(name) {
  try { check(name); const b = backend(); return !!(b && (await b.get(name))); } catch { return false; }
}
export async function removeSecret(name) {
  check(name);
  const b = backend();
  if (b) await b.remove(name);
}
