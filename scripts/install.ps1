# Magpie installer (Windows) - no Node/npm/docker required.
#
#   irm https://ssh-ai.github.io/magpie/install.ps1 | iex
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

$repo = "ssh-ai/magpie"
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

# Auto-register with Claude Code. No MAGPIE_EXTENSION is written: magpie-mcp
# derives @<os-user>/main and sanitizes the name first, which matters more on
# Windows than anywhere else (domain logins arrive as "CORP\alice").
if (Get-Command claude -ErrorAction SilentlyContinue) {
  # native commands do not throw on non-zero exit here, so test $LASTEXITCODE
  $exists = $false
  try { claude mcp get magpie *> $null; $exists = ($LASTEXITCODE -eq 0) } catch { $exists = $false }
  if (-not $exists) {
    claude mcp add magpie --scope user -- (Join-Path $dir "magpie-mcp.exe")
    Write-Host "-> Claude Code: registered magpie MCP"
  } else {
    Write-Host "-> Claude Code: magpie MCP already registered"
  }
}

# Codex and Gemini were registered on Unix but not here, so a Windows user of
# either got a working binary and no way for their agent to reach it. Both
# expose an idempotent `mcp add`; neither needs its config file to exist first.
$mcpExe = Join-Path $dir "magpie-mcp.exe"

# Every check below reads $LASTEXITCODE, which is STALE if the call never ran.
# Seeding it with a failure first means a throw reports failure rather than
# inheriting whatever the previous command happened to leave behind.
function Invoke-Register([string]$label, [scriptblock]$call, [string]$manual) {
  $script:LASTEXITCODE = 1
  try { & $call *> $null } catch { }
  if ($LASTEXITCODE -eq 0) { return $true }
  Write-Host "! ${label}: auto-register failed - run: $manual"
  return $false
}

if (Get-Command codex -ErrorAction SilentlyContinue) {
  $script:LASTEXITCODE = 1
  try { codex mcp get magpie *> $null } catch { }
  if ($LASTEXITCODE -eq 0) {
    Write-Host "-> Codex: magpie MCP already registered"
  } elseif (Invoke-Register "Codex" { codex mcp add magpie -- $mcpExe } "codex mcp add magpie -- $mcpExe") {
    Write-Host "-> Codex: registered magpie MCP"
  }
}

# -s user is mandatory: gemini defaults to PROJECT scope, which would write the
# registration into whatever directory this script was piped into.
if (Get-Command gemini -ErrorAction SilentlyContinue) {
  if (Invoke-Register "Gemini CLI" { gemini mcp add -s user magpie $mcpExe } "gemini mcp add -s user magpie $mcpExe") {
    Write-Host "-> Gemini CLI: magpie MCP registered"
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
