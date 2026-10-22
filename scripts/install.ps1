# Install the EML Cockpit on Windows: the one-line installer for people without
# a developer setup. It is attached to every GitHub release, so (in PowerShell)
#
#   irm https://github.com/EpistemicLabs/eml/releases/latest/download/install.ps1 | iex
#
# always runs the installer of the newest release (install-eml-cockpit.cmd runs
# it on a double-click). Keep this file ASCII: Windows PowerShell 5.1 reads a
# script without a BOM as ANSI. It needs nothing installed: no Node, no git, no
# GitHub account, no admin rights. It brings the cockpit's own Node (the newest
# of the major the CI tests, from nodejs.org, checked against its SHASUMS256)
# into <home>\node\, downloads the release tarballs, checks them against
# SHA256SUMS, installs them into
# <home>\app\versions\<v>\ (the layout the in-app updater uses) and registers the
# autostart (the user's Run key, `eml-cockpit service install`). Later updates
# come through the cockpit's update banner. The macOS twin is install.sh.
#
# Env overrides: EML_COCKPIT_HOME (default ~\.eml-cockpit), COCKPIT_PORT (4317),
# EML_VERSION (default: newest release), EML_NO_OPEN=1 (don't open the browser),
# EML_FROM (a folder with the release assets instead of downloading them).

# The Node major the cockpit runs on Windows: the one the CI tests
# (node-version in .github/workflows/ci.yml). Change both together.
$NodeMajor = 22

# Everything runs inside the function, so a download cut off halfway through runs nothing.
function Install-EmlCockpit {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times slower with the bar
  # Windows PowerShell 5.1 may not offer TLS 1.2 by itself; GitHub requires it.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $repo = 'EpistemicLabs/eml'
  $homeDir = if ($env:EML_COCKPIT_HOME) { $env:EML_COCKPIT_HOME } else { Join-Path $env:USERPROFILE '.eml-cockpit' }
  $port = if ($env:COCKPIT_PORT) { [int]$env:COCKPIT_PORT } else { 4317 }
  $url = "http://127.0.0.1:$port"
  $app = Join-Path $homeDir 'app'
  $current = Join-Path $app 'current'
  $label = "EML Cockpit $port"

  function Say($text) { Write-Host $text -ForegroundColor White }
  function Fail($text) { throw "Installation stopped: $text" }
  function PortTaken {
    $client = New-Object System.Net.Sockets.TcpClient
    try { $client.Connect('127.0.0.1', $port); return $true } catch { return $false } finally { $client.Close() }
  }

  # The cockpit's own Node in <home>\node\<version>, <home>\node\current a junction
  # to it: never the user's Node (whose version or removal must not break the
  # cockpit), never on the user's PATH. Returns the path of node.exe.
  function Install-Node {
    $nodeRoot = Join-Path $homeDir 'node'
    $nodeCurrent = Join-Path $nodeRoot 'current'
    $cpu = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($cpu) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { $null } }
    if (-not $arch) { Fail "this Windows ($cpu) is not supported. The cockpit needs 64-bit Windows (x64 or ARM64)." }
    try { $index = Invoke-RestMethod -UseBasicParsing -Uri 'https://nodejs.org/dist/index.json' }
    catch { Fail 'could not reach nodejs.org to get Node.js. Check your internet connection and try again.' }
    $release = $index | Where-Object { $_.version -like "v$NodeMajor.*" -and $_.files -contains "win-$arch-zip" } | Select-Object -First 1
    if (-not $release) { Fail "nodejs.org lists no Node.js $NodeMajor for Windows $arch." }
    $v = $release.version
    $dir = Join-Path $nodeRoot $v
    if (-not (Test-Path (Join-Path $dir 'node.exe'))) {
      Write-Host "  downloading Node.js $v ($arch)"
      $name = "node-$v-win-$arch"
      $staging = Join-Path $nodeRoot (".staging-" + [System.IO.Path]::GetRandomFileName())
      New-Item -ItemType Directory -Force -Path $staging | Out-Null
      try {
        $zip = Join-Path $staging "$name.zip"
        $sums = Join-Path $staging 'SHASUMS256.txt'
        try {
          Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$v/$name.zip" -OutFile $zip
          Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/$v/SHASUMS256.txt" -OutFile $sums
        } catch { Fail 'the download of Node.js failed. Check your internet connection and try again.' }
        $expected = $null
        foreach ($line in Get-Content -LiteralPath $sums) {
          if ($line -match "^([0-9a-f]{64})\s+$([regex]::Escape("$name.zip"))$") { $expected = $Matches[1]; break }
        }
        $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLower()
        if (-not $expected -or $expected -ne $actual) { Fail 'the downloaded Node.js does not match its published checksum. Nothing was installed.' }
        # tar (bsdtar, in Windows since 10 1803) unpacks zips many times faster than Expand-Archive.
        & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $zip -C $staging
        if ($LASTEXITCODE -ne 0) { Fail 'could not unpack Node.js.' }
        Move-Item -LiteralPath (Join-Path $staging $name) -Destination $dir
      } finally {
        Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
      }
    }
    if (Get-Item -LiteralPath $nodeCurrent -Force -ErrorAction SilentlyContinue) { [System.IO.Directory]::Delete($nodeCurrent) }
    New-Item -ItemType Junction -Path $nodeCurrent -Target $dir | Out-Null
    Write-Host "  Node.js $v ready"
    return (Join-Path $nodeCurrent 'node.exe')
  }

  # Installed and registered: nothing to do. Installed but not registered (an
  # earlier run failed at the autostart, or it was uninstalled and the brain
  # kept): register it again below instead of reinstalling.
  $registered = $null -ne (Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name $label -ErrorAction SilentlyContinue)
  if ((Test-Path $current) -and $registered) {
    Say "The EML Cockpit is already installed in $homeDir."
    Write-Host 'Updates come through the cockpit itself (update banner, or Settings > About > Updates).'
    Write-Host "Open it: $url"
    return
  }
  $node = Install-Node
  # npm's own script with that node: npm.cmd needs a shell, npm.ps1 may be blocked by the execution policy.
  $npmCli = Join-Path (Split-Path $node) 'node_modules\npm\bin\npm-cli.js'
  # For this process only: npm's install scripts (node-pty's) start `node` from PATH.
  $env:PATH = (Split-Path $node) + ';' + $env:PATH

  if (-not $registered -and (PortTaken)) {
    Fail "port $port is already in use by another program (perhaps a cockpit started from a checkout). Stop it, then run the command again."
  }

  if (Test-Path $current) {
    Say "Found an installed EML Cockpit in $homeDir, registering it again ..."
  } else {
    $from = $env:EML_FROM
    $tag = $env:EML_VERSION
    if ($from) {
      $tarball = Get-ChildItem -LiteralPath $from -Filter 'eml-cockpit-*.tgz' | Select-Object -First 1
      if (-not $tarball) { Fail "no eml-cockpit-<version>.tgz in $from" }
      $tag = 'v' + ($tarball.Name -replace '^eml-cockpit-(.+)\.tgz$', '$1')
    } elseif (-not $tag) {
      # The releases/latest page redirects to .../releases/tag/v<version>; no API, no rate limit.
      try {
        $request = [System.Net.HttpWebRequest]::Create("https://github.com/$repo/releases/latest")
        $request.AllowAutoRedirect = $false
        $response = $request.GetResponse()
        $tag = ($response.Headers['Location'] -split '/')[-1]
        $response.Close()
      } catch { Fail 'could not reach GitHub. Check your internet connection and try again.' }
    }
    if (-not $tag.StartsWith('v')) { $tag = "v$tag" }
    $v = $tag.Substring(1)
    if ($v -notmatch '^\d+\.\d+\.\d+$') { Fail "could not find the newest release (got '$tag'). Check your internet connection." }

    Say "Installing EML Cockpit v$v into $homeDir ..."
    New-Item -ItemType Directory -Force -Path (Join-Path $app 'versions') | Out-Null
    $staging = Join-Path $app (".staging-" + [System.IO.Path]::GetRandomFileName())
    $tarballs = Join-Path $staging 'tarballs'
    New-Item -ItemType Directory -Force -Path $tarballs | Out-Null
    try {
      $names = @("eml-cockpit-$v.tgz", "engramprotocol-mcp-server-$v.tgz", 'SHA256SUMS')
      foreach ($name in $names) {
        $target = Join-Path $tarballs $name
        if ($from) {
          Copy-Item -LiteralPath (Join-Path $from $name) -Destination $target
        } else {
          Write-Host "  downloading $name"
          try { Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$repo/releases/download/$tag/$name" -OutFile $target }
          catch { Fail "download of $name failed. Check your internet connection and try again." }
        }
      }
      $sums = @{}
      foreach ($line in Get-Content -LiteralPath (Join-Path $tarballs 'SHA256SUMS')) {
        if ($line -match '^([0-9a-f]{64})\s+\*?(.+)$') { $sums[$Matches[2].Trim()] = $Matches[1] }
      }
      foreach ($name in $names[0..1]) {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $tarballs $name)).Hash.ToLower()
        if ($sums[$name] -ne $hash) { Fail 'the downloaded files do not match their checksums. Nothing was installed.' }
      }
      Write-Host '  checksums ok'

      Write-Host '  installing (this takes a minute)'
      Set-Content -LiteralPath (Join-Path $staging 'package.json') -Value '{ "name": "eml-cockpit-app", "private": true }' -Encoding ASCII
      Push-Location $staging
      try {
        & $node $npmCli install --no-fund --no-audit --omit=dev --loglevel=error ".\tarballs\engramprotocol-mcp-server-$v.tgz" ".\tarballs\eml-cockpit-$v.tgz"
        if ($LASTEXITCODE -ne 0) { Fail 'npm install failed (see the messages above).' }
      } finally { Pop-Location }

      $versionDir = Join-Path (Join-Path $app 'versions') $v
      if (Test-Path $versionDir) { Remove-Item -LiteralPath $versionDir -Recurse -Force }
      Move-Item -LiteralPath $staging -Destination $versionDir
    } finally {
      if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
    }
    # `current` is a junction (no admin rights needed); Directory.Delete removes
    # the junction itself, never what it points at.
    if (Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue) { [System.IO.Directory]::Delete($current) }
    New-Item -ItemType Junction -Path $current -Target $versionDir | Out-Null
  }

  $env:EML_COCKPIT_HOME = $homeDir
  $env:COCKPIT_PORT = "$port"
  & $node (Join-Path $current 'node_modules\eml-cockpit\dist\index.js') service install | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Fail 'the cockpit is installed, but its autostart could not be registered. Run the command again; if it stops here again, open an issue.'
  }

  Write-Host '  starting'
  $up = $false
  for ($i = 0; $i -lt 90 -and -not $up; $i++) {
    try { $up = (Invoke-WebRequest -UseBasicParsing -Uri "$url/health" -TimeoutSec 2).StatusCode -eq 200 } catch { Start-Sleep -Seconds 1 }
  }
  if (-not $up) { Fail "the cockpit did not start within a minute and a half. Its log is $homeDir\host.log, attach it when you open an issue." }

  Write-Host ''
  Say "Done. The EML Cockpit runs at $url"
  Write-Host 'It starts on its own at every login. Updates appear as a banner inside the cockpit.'
  if (-not $env:EML_NO_OPEN) { Start-Process $url }
}

Install-EmlCockpit
