#!/bin/sh
# Magpie installer — one line, no Node/npm/docker required.
#
#   curl -fsSL https://sshaipowered.github.io/magpie/install.sh | sh
#
# Installs the magpie binaries (CLI, relay, MCP server — all standalone) into
# ~/.magpie/bin and auto-registers the MCP server with every agent it can detect
# (Claude Code, Codex, Gemini CLI; prints the command to paste for the rest).
set -eu

REPO="sshaipowered/magpie"
INSTALL_DIR="${MAGPIE_HOME:-$HOME/.magpie}/bin"
BASE="https://github.com/$REPO/releases/latest/download"

# --- detect platform ---------------------------------------------------------
os=$(uname -s)
arch=$(uname -m)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) echo "unsupported OS: $os (Windows: use install.ps1)"; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) echo "unsupported arch: $arch"; exit 1 ;;
esac
target="$os-$arch"

# --- download + unpack -------------------------------------------------------
echo "→ installing magpie ($target) to $INSTALL_DIR"
mkdir -p "$INSTALL_DIR"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$BASE/magpie-$target.tar.gz" -o "$tmp/magpie.tar.gz"
tar -xzf "$tmp/magpie.tar.gz" -C "$INSTALL_DIR"
chmod +x "$INSTALL_DIR/magpie" "$INSTALL_DIR/magpie-relay" "$INSTALL_DIR/magpie-mcp"

# --- PATH --------------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    line="export PATH=\"$INSTALL_DIR:\$PATH\""
    for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
      [ -f "$rc" ] && ! grep -qs "$INSTALL_DIR" "$rc" && printf '\n# magpie\n%s\n' "$line" >> "$rc"
    done
    echo "→ added $INSTALL_DIR to PATH (restart your shell)"
    ;;
esac

# --- auto-register the MCP server with detected agents ------------------------
# No MAGPIE_EXTENSION is written: magpie-mcp derives @<os-user>/main itself, and
# it sanitizes the username first. This script used to pass "@$(whoami)/main"
# straight through, which produced an address the MCP then rejected for anyone
# whose account name has a capital, a space, or a dot ("Sang Hoon", "John.Doe").
# Deriving in one tested place beats reimplementing that here.
#
# Every host is registered through its own `mcp add` subcommand rather than by
# editing its config file. Hand-editing gated Codex behind an existing
# ~/.codex/config.toml, so anyone who had installed Codex but never launched it
# got silently skipped. All three commands are idempotent.

if command -v claude >/dev/null 2>&1; then
  if claude mcp get magpie >/dev/null 2>&1; then
    echo "→ Claude Code: magpie MCP already registered"
  else
    claude mcp add magpie --scope user -- "$INSTALL_DIR/magpie-mcp" \
      && echo "→ Claude Code: registered magpie MCP" \
      || echo "! Claude Code: auto-register failed — run: claude mcp add magpie -- $INSTALL_DIR/magpie-mcp"
  fi
fi

if command -v codex >/dev/null 2>&1; then
  if codex mcp get magpie >/dev/null 2>&1; then
    echo "→ Codex: magpie MCP already registered"
  else
    codex mcp add magpie -- "$INSTALL_DIR/magpie-mcp" >/dev/null 2>&1 \
      && echo "→ Codex: registered magpie MCP" \
      || echo "! Codex: auto-register failed — run: codex mcp add magpie -- $INSTALL_DIR/magpie-mcp"
  fi
fi

# Gemini CLI is the one third-party host magpie has been verified against on a
# live cross-vendor call, so leaving it out of auto-registration was backwards.
# `-s user` is mandatory: `gemini mcp add` defaults to PROJECT scope and would
# otherwise bury the registration in whatever directory this script ran from.
if command -v gemini >/dev/null 2>&1; then
  if gemini mcp add -s user magpie "$INSTALL_DIR/magpie-mcp" >/dev/null 2>&1; then
    echo "→ Gemini CLI: magpie MCP registered"
    # Gemini gates MCP servers behind folder trust: in an untrusted directory it
    # lists magpie as "Disabled" and never says trust is the reason. That is
    # their security setting, not ours to flip — so name it instead.
    echo "  (lists as Disabled? that is Gemini's folder-trust gate — trust the folder)"
  else
    echo "! Gemini CLI: auto-register failed — run: gemini mcp add -s user magpie $INSTALL_DIR/magpie-mcp"
  fi
fi

echo ""
echo "✅ magpie installed."
echo ""
echo "One of you runs the relay; the other needs nothing (the invite carries its address):"
echo "  magpie-relay                                     # on any host both agents can reach"
echo "  export MAGPIE_RELAY_URL=ws://<host>.local:8787   # on the STARTING side only"
echo "It brokers ciphertext only; it can never read your code or messages."
echo ""
echo "Start a call:   tell your agent  \"start a magpie call about <topic>\""
echo "                → it prints an invite like  K7F3-9M2P-XQ4R@wss://relay-host"
echo "Join a call:    tell your agent  \"join <invite>\"   (no other setup needed)"
echo ""
echo "Other agents (Antigravity, …): register the MCP command manually:"
echo "  $INSTALL_DIR/magpie-mcp   (no env needed)"
echo ""
echo "Your agent's address defaults to @<your-username>/main."
echo "Set MAGPIE_EXTENSION=@you/role to pick a different one."
