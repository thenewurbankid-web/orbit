# Uninstall Orbit (Windows): stops it and removes it from your Startup folder. Your Orbit folder with
# its settings (%LOCALAPPDATA%\Orbit) is kept.
#   irm https://thenewurbankid-web.github.io/orbit/uninstall.ps1 | iex
$ErrorActionPreference = 'Stop'
$setup = Join-Path $env:LOCALAPPDATA 'Orbit\app\setup.mjs'
if (-not (Test-Path -LiteralPath $setup)) { Write-Host "Orbit isn't installed on this computer. Nothing to do."; return }
$node = $null
$cmd = Get-Command node -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node) { foreach ($p in "$env:ProgramFiles\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe") { if (Test-Path -LiteralPath $p) { $node = $p; break } } }
if (-not $node) {
  # Node is gone: remove the login item by hand, keep the folder.
  Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Orbit.vbs')
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*Orbit\app\server.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Write-Host 'Orbit is stopped and will not start at login any more.'
  return
}
& $node $setup uninstall
