#!/bin/sh
# Install claude-autoroute from this folder, then run the guided setup.
#
#   ./install.sh            install and set up
#   ./install.sh --no-setup install only
#
# Works without admin rights: if npm can't write to its global folder, it installs into
# ~/.local instead. Nothing is downloaded (there are no dependencies). The installed copy
# doesn't depend on this folder, so you can delete the download afterwards.
set -eu

cd "$(dirname "$0")"
say() { printf '%s\n' "$*"; }
fail() { say "install: $*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || fail "Node.js isn't installed. Install Node.js 20 or later from https://nodejs.org, then run this again."
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' \
  || fail "Node.js $(node -v) is too old. Install Node.js 20 or later from https://nodejs.org, then run this again."
command -v npm >/dev/null 2>&1 || fail "npm isn't available. It comes with Node.js from https://nodejs.org."
command -v claude >/dev/null 2>&1 || say "Note: Claude Code (claude) isn't on your PATH yet. Install it before using claude-auto."

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# A private, empty npm cache: nothing is downloaded, and it avoids a common problem where
# ~/.npm contains files owned by root (npm then fails with EACCES).
npm_config_cache="$tmp/cache"; export npm_config_cache
say "Packing claude-autoroute..."
npm pack --pack-destination "$tmp" >/dev/null 2>"$tmp/err" || { cat "$tmp/err" >&2; fail "npm pack failed (see above)."; }
pkg=$(ls "$tmp"/claude-autoroute-*.tgz)

say "Installing..."
if npm install --global --loglevel=error --no-audit --no-fund "$pkg" 2>"$tmp/err"; then
  bin=$(npm prefix --global)/bin
else
  if grep -q "EACCES\|EPERM\|permission denied" "$tmp/err"; then
    say "No permission for npm's global folder, so installing into ~/.local instead (no admin rights needed)."
    npm install --global --loglevel=error --no-audit --no-fund --prefix "$HOME/.local" "$pkg"
    bin="$HOME/.local/bin"
  else
    cat "$tmp/err" >&2
    fail "npm install failed (see above)."
  fi
fi

case ":$PATH:" in
  *":$bin:"*) ;;
  *)
    shell_rc="$HOME/.profile"
    case "${SHELL:-}" in */zsh) shell_rc="$HOME/.zshrc" ;; */bash) shell_rc="$HOME/.bashrc" ;; esac
    say ""
    say "One more step: add $bin to your PATH. Run this, then open a new terminal:"
    say "  echo 'export PATH=\"$bin:\$PATH\"' >> $shell_rc"
    PATH="$bin:$PATH"; export PATH
    ;;
esac

say "Installed: $("$bin/autoroute" version)"
if [ "${1:-}" = "--no-setup" ]; then
  say "Next: autoroute setup"
  exit 0
fi
say ""
exec "$bin/autoroute" setup
