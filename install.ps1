# Orbit helper, the one-line way (Windows). The usual way is the Download button on
# https://thenewurbankid-web.github.io/orbit/ ; this does the same from PowerShell:
#
#   irm https://thenewurbankid-web.github.io/orbit/install.ps1 | iex
#
# Finds Node.js, downloads Orbit for Windows, checks its SHA-256, and runs its setup: files go in
# %LOCALAPPDATA%\Orbit, it starts at login from your Startup folder. No admin needed.
$ErrorActionPreference = 'Stop'
# Written by helper/build.mjs.
$OrbitRef = ''
$SumWindows = 'd4b141d94b848aa26eabec05e7027db02bf82ce92fddfc84a45a1042d77dd51a'
$OrbitBase = if ($env:ORBIT_BASE) { $env:ORBIT_BASE } else { 'https://thenewurbankid-web.github.io/orbit' }

function Say($t) { Write-Host $t }
function Stop-Orbit($t) { Write-Host ''; Write-Host $t; return }

function Test-Node($p) {
  if (-not $p -or -not (Test-Path -LiteralPath $p)) { return $false }
  & $p -e "process.exit(+process.versions.node.split('.')[0]>=20?0:1)" 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}
function Find-Node {
  $c = @()
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $c += $cmd.Source }
  $shim = Get-ChildItem -ErrorAction SilentlyContinue "$env:USERPROFILE\.local\bin\paperclipai*"
  if ($shim) { $m = Select-String -Path $shim.FullName -Pattern '[A-Za-z]:\\[^''"]*node\.exe' | Select-Object -First 1; if ($m) { $c += $m.Matches[0].Value } }
  $c += "$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe", "$env:LOCALAPPDATA\Volta\bin\node.exe"
  if ($env:NVM_SYMLINK) { $c += "$env:NVM_SYMLINK\node.exe" }
  foreach ($p in $c) { if (Test-Node $p) { return $p } }
  return $null
}

$node = Find-Node
if (-not $node) { Stop-Orbit "Orbit needs Node.js 20 or newer, and it isn't on this computer yet. Install it from https://nodejs.org (the LTS button), then run the line again."; return }
if (-not $SumWindows) { Stop-Orbit "This installer isn't ready yet. Please use the Download button on the Orbit page."; return }
$src = if ($OrbitRef -and -not $env:ORBIT_BASE_FORCE) { "https://raw.githubusercontent.com/thenewurbankid-web/orbit/$OrbitRef" } else { $OrbitBase }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("orbit-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp | Out-Null
try {
  Say '... downloading Orbit'
  $zip = Join-Path $tmp 'Orbit-windows.zip'
  try { Invoke-WebRequest -UseBasicParsing -Uri "$src/download/Orbit-windows.zip" -OutFile $zip } catch { Stop-Orbit "Couldn't download Orbit. Check the internet connection and run the line again."; return }
  $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
  if ($got -ne $SumWindows) { Stop-Orbit "The download didn't match what we expected, so nothing was installed. Please try again in a few minutes."; return }
  Say 'OK  Downloaded and checked'
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
  $env:ORBIT_NO_PAUSE = '1'
  & $node (Join-Path $tmp 'Orbit\helper\setup.mjs')
} finally {
  Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
