# CI (Windows): install the cockpit with install.ps1 from release assets packed
# from this checkout, the way a user's one-liner does, then check the autostart
# and remove it again. Needs `pnpm build`, the frontend and the eml-cockpit build.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path ([System.IO.Path]::GetTempPath()) ('eml-assets-' + [System.IO.Path]::GetRandomFileName())
$homeDir = Join-Path ([System.IO.Path]::GetTempPath()) ('eml-home-' + [System.IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Force -Path $assets | Out-Null

foreach ($pkg in 'packages\mcp-server', 'cockpit\host') {
  Push-Location (Join-Path $root $pkg)
  try { & pnpm pack --pack-destination $assets | Out-Null; if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed in $pkg" } }
  finally { Pop-Location }
}
$lines = Get-ChildItem -LiteralPath $assets -Filter '*.tgz' | ForEach-Object {
  "$((Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLower())  $($_.Name)"
}
Set-Content -LiteralPath (Join-Path $assets 'SHA256SUMS') -Value $lines -Encoding ASCII

$env:EML_FROM = $assets
$env:EML_COCKPIT_HOME = $homeDir
$env:COCKPIT_PORT = '4399'
$env:EML_NO_OPEN = '1'
$node = (Get-Command node.exe).Source
$entry = Join-Path $homeDir 'app\current\node_modules\eml-cockpit\dist\index.js'
try {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'install.ps1 failed' }

  $status = & $node $entry service status | Out-String
  Write-Host $status
  if ($status -notmatch 'installed: yes' -or $status -notmatch 'running:\s+yes' -or $status -notmatch 'port 4399: responds') { throw 'the autostart is not installed and running' }
  if (-not (Test-Path (Join-Path $homeDir 'host.log'))) { throw 'the host writes no log' }
  Write-Host "--- host.log ---"; Get-Content -LiteralPath (Join-Path $homeDir 'host.log') -Tail 15

  # Again: an installed and registered cockpit is left as it is.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'scripts\install.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'a second install.ps1 run failed' }

  & $node $entry service uninstall
  Start-Sleep -Seconds 3
  $client = New-Object System.Net.Sockets.TcpClient
  $stillUp = $true
  try { $client.Connect('127.0.0.1', 4399) } catch { $stillUp = $false } finally { $client.Close() }
  if ($stillUp) { throw 'the host still runs after service uninstall' }
  $left = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'EML Cockpit 4399' -ErrorAction SilentlyContinue
  if ($left) { throw 'the Run key value is still there after service uninstall' }
  Write-Host 'install test passed'
} finally {
  if (Test-Path (Join-Path $homeDir 'host.log')) { Write-Host '--- host.log (end) ---'; Get-Content -LiteralPath (Join-Path $homeDir 'host.log') -Tail 30 }
}
