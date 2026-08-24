# Magpie installer (Windows) - no Node/npm/docker required.
#
#   irm https://sshaipowered.github.io/magpie/install.ps1 | iex
#
# Installs magpie binaries to ~\.magpie\bin and registers the MCP server with
# Claude Code, Codex and Gemini CLI if present.
#
# KEEP THIS FILE PURE ASCII. Pages serves it as application/octet-stream with
# no charset and no BOM, so Windows PowerShell 5.1 (what `irm | iex` runs on a
# default Windows box) decodes it with the machine's ANSI codepage. Under that
# decode a UTF-8 em dash inside a double-quoted string becomes bytes that
# terminate the string early and the whole script stops parsing. That is not a
# cosmetic defect, it is no install at all, and macOS cannot see it because
# every other platform decodes the file as UTF-8.
#
# Only string literals are actually fatal, but "non-ASCII is fine in comments"
# is a rule nobody remembers at 2am. CI enforces the whole file.
$ErrorActionPreference = "Stop"

$repo = "sshaipowered/magpie"
$dir  = Join-Path $HOME ".magpie\bin"
$url  = "https://github.com/$repo/releases/latest/download/magpie-windows-x64.zip"

Write-Host "-> installing magpie (windows-x64) to $dir"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$zip = Join-Path $env:TEMP "magpie.zip"
Invoke-WebRequest -Uri $url -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $dir -Force
Remove-Item $zip

# PATH (user)
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$dir*") {
  [Environment]::SetEnvironmentVariable("Path", "$dir;$userPath", "User")
  Write-Host "-> added $dir to PATH (restart your terminal)"
}

# --- auto-register the MCP server with detected agents ------------------------
# No MAGPIE_EXTENSION is written anywhere below: magpie-mcp derives
# @<os-user>/main and sanitizes the name itself, which matters more on Windows
# than anywhere else (domain logins arrive as "CORP\alice").
#
# Codex and Gemini were registered on Unix but not here, so a Windows user of
# either got a working binary and no way for their agent to reach it. All three
# CLIs expose an idempotent `mcp add` and none needs its config to exist first.
$mcpExe = Join-Path $dir "magpie-mcp.exe"

# Registration is judged by OUTCOME, never by exit code.
#
# An earlier version seeded $script:LASTEXITCODE before each call so a throw
# could not inherit a stale value. That backfired: $LASTEXITCODE is a GLOBAL
# automatic variable, so the script-scoped assignment created a shadow that
# native commands never update, every read found the shadow still holding its
# seeded failure value, and registration reported failure unconditionally --
# including the runs where it had in fact succeeded.
#
# These CLIs also arrive as npm .cmd shims on Windows, whose exit codes do not
# reliably survive the shim. Reading the config file the CLI was told to write
# is ground truth and depends on none of that.
function Register-Host([string]$label, [scriptblock]$call, [string]$config, [string]$needle, [string]$manual) {
  $out = ''
  try { $out = (& $call 2>&1 | Out-String) } catch { $out = $_.Exception.Message }
  if ((Test-Path $config) -and ((Get-Content $config -Raw -ErrorAction SilentlyContinue) -match $needle)) {
    Write-Host "-> ${label}: magpie MCP registered"
    return $true
  }
  Write-Host "! ${label}: auto-register failed - run: $manual"
  # Print what the CLI said. Swallowing it is why the Unix and Windows paths
  # diverged unnoticed for as long as they did.
  if ($out.Trim()) {
    foreach ($line in ($out.Trim() -split "`r?`n")) { Write-Host "  $line" }
  }
  return $false
}

if (Get-Command claude -ErrorAction SilentlyContinue) {
  [void](Register-Host "Claude Code" { claude mcp add magpie --scope user -- $mcpExe } `
    (Join-Path $HOME ".claude.json") '"magpie"' "claude mcp add magpie --scope user -- $mcpExe")
}

if (Get-Command codex -ErrorAction SilentlyContinue) {
  $codexCfg = if ($env:CODEX_HOME) { Join-Path $env:CODEX_HOME "config.toml" }
              else { Join-Path $HOME ".codex\config.toml" }
  [void](Register-Host "Codex" { codex mcp add magpie -- $mcpExe } `
    $codexCfg "mcp_servers\.magpie" "codex mcp add magpie -- $mcpExe")
}

# -s user is mandatory: gemini defaults to PROJECT scope, which would write the
# registration into whatever directory this script was piped into.
if (Get-Command gemini -ErrorAction SilentlyContinue) {
  $geminiCfg = Join-Path $HOME ".gemini\settings.json"
  if (Register-Host "Gemini CLI" { gemini mcp add -s user magpie $mcpExe } `
      $geminiCfg '"magpie"' "gemini mcp add -s user magpie $mcpExe") {
    # Gemini's folder-trust gate reports the server as "Disabled" without ever
    # saying trust is why. Their setting to flip, ours to name.
    Write-Host "  (lists as Disabled? that is Gemini's folder-trust gate - trust the folder)"
  }
}

Write-Host ""
Write-Host "OK: magpie installed."
Write-Host "Nothing else to set up. A hosted relay is the default, and it brokers"
Write-Host "ciphertext only, so it can never read your code or messages."
Write-Host ""
Write-Host "Start a call:  tell your agent  `"start a magpie call about <topic>`""
Write-Host "Join a call:   tell your agent  `"join <invite>`""
Write-Host ""
Write-Host "Prefer your own relay? run  magpie-relay  and set MAGPIE_RELAY_URL"

# Reaching here means every fallible step succeeded -- $ErrorActionPreference is
# Stop, so a real failure throws long before this line. Without the reset the
# script leaks whatever the last registration CLI happened to return, and a
# caller that checks $LASTEXITCODE after `irm | iex` reads a successful install
# as a failed one.
$global:LASTEXITCODE = 0
