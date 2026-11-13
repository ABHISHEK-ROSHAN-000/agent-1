[CmdletBinding()]
param(
  [string]$Version = "",
  [string]$FromFile = "",
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "Programs\Agent-1"),
  [string]$Repository = "ABHISHEK-ROSHAN-000/agent-1",
  [string]$ManifestUrl = "",
  [switch]$NoPath,
  [switch]$NoShortcut,
  [switch]$NoOnboard,
  [switch]$NoAutostart,
  [switch]$EnableAutostart
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step([string]$Message) {
  Write-Host "==> $Message"
}

function Fail([string]$Message) {
  Write-Error $Message
  exit 1
}

function Download-File([string]$Uri, [string]$OutFile) {
  $lastError = $null
  for ($attempt = 1; $attempt -le 10; $attempt++) {
    Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
    try {
      Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -TimeoutSec 600
      if (Test-Path $OutFile) { return }
    } catch {
      $lastError = $_
      Write-Warning "Download attempt $attempt failed: $($_.Exception.Message)"
      Start-Sleep -Seconds (2 * $attempt)
    }
  }
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    Remove-Item $OutFile -Force -ErrorAction SilentlyContinue
    & curl.exe -L --fail --http1.1 --retry 10 --retry-all-errors --retry-delay 2 --output $OutFile $Uri
    if ($LASTEXITCODE -eq 0 -and (Test-Path $OutFile)) { return }
  }
  throw $lastError
}

if ($env:PROCESSOR_ARCHITECTURE -ne "AMD64") {
  Fail "Agent-1 currently supports Windows x64 only."
}

$releaseBase = "https://github.com/$Repository/releases"
if (-not $ManifestUrl) { $ManifestUrl = "$releaseBase/latest/download/latest.json" }
$tempRoot = Join-Path $env:TEMP ("agent-1-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempRoot | Out-Null

$manifest = $null
$zip = Join-Path $tempRoot "agent-1.zip"

try {
  Write-Step "Resolving Agent-1 release"
  if ($FromFile) {
    if (-not (Test-Path $FromFile)) { Fail "Package not found: $FromFile" }
    Copy-Item $FromFile $zip
    if (-not $Version) {
      $name = [System.IO.Path]::GetFileNameWithoutExtension($FromFile)
      if ($name -match 'agent-1-windows-x64-(.+)$') { $Version = $Matches[1] }
      elseif ($name -match 'agent-1-(.+)$') { $Version = $Matches[1] }
    }
    if (-not $Version) { $Version = "0.1.4" }
    Write-Host "    Using local package $FromFile"
  } else {
    $manifest = Invoke-RestMethod -Uri $manifestUrl -UseBasicParsing -Headers @{ Accept = "application/json" }
    if (-not $Version) { $Version = [string]$manifest.version }
    if (-not $Version) { Fail "The update manifest did not contain a version." }
    if ($manifest.parts -and $manifest.parts.Count -gt 0) {
      $partPaths = @()
      foreach ($part in $manifest.parts) {
        $name = [System.IO.Path]::GetFileName([string]$part.name)
        $partPath = Join-Path $tempRoot $name
        Write-Host "    Downloading $name"
        Download-File ([string]$part.url) $partPath
        if ($part.sha256) {
          $partActual = (Get-FileHash -Algorithm SHA256 -Path $partPath).Hash.ToLowerInvariant()
          if ($partActual -ne ([string]$part.sha256).ToLowerInvariant()) {
            Fail "Part checksum mismatch for $name."
          }
        }
        $partPaths += $partPath
      }
      $output = [System.IO.File]::Open($zip, [System.IO.FileMode]::Create)
      try {
        foreach ($partPath in $partPaths) {
          $stream = [System.IO.File]::OpenRead($partPath)
          try { $stream.CopyTo($output) } finally { $stream.Dispose() }
        }
      } finally {
        $output.Dispose()
      }
    } else {
      $downloadUrl = [string]$manifest.url
      if (-not $downloadUrl) {
        $downloadUrl = "$releaseBase/download/v$Version/agent-1-windows-x64.zip"
      }
      Write-Host "    Downloading $downloadUrl"
      Download-File $downloadUrl $zip
    }
    if ($manifest.sha256) {
      $actual = (Get-FileHash -Algorithm SHA256 -Path $zip).Hash.ToLowerInvariant()
      if ($actual -ne ([string]$manifest.sha256).ToLowerInvariant()) {
        Fail "SHA-256 mismatch. Expected $($manifest.sha256), got $actual."
      }
      Write-Host "    SHA-256 verified"
    }
  }

  $versionDir = Join-Path $InstallDir ("versions\" + $Version)
  $current = Join-Path $InstallDir "current"
  $bin = Join-Path $InstallDir "bin"
  $oldCmd = Join-Path $bin "agent-1.cmd"

  if (Test-Path $oldCmd) {
    try {
      Write-Step "Stopping the current service"
      & cmd.exe /c "`"$oldCmd`" service stop" | Out-Null
    } catch {
      Write-Warning "Could not stop the current service automatically."
    }
  }

  Write-Step "Installing Agent-1 $Version"
  if (Test-Path $versionDir) { Remove-Item -Recurse -Force $versionDir }
  New-Item -ItemType Directory -Force -Path $versionDir | Out-Null
  Expand-Archive -Path $zip -DestinationPath $versionDir -Force

  if (-not (Test-Path (Join-Path $versionDir "agent-1.exe"))) {
    Fail "The package does not contain agent-1.exe."
  }

  if (Test-Path $current) {
    & cmd.exe /c "rmdir `"$current`"" | Out-Null
  }
  New-Item -ItemType Junction -Path $current -Target $versionDir | Out-Null

  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $cmd = @(
    '@echo off',
    '"%~dp0..\current\agent-1.exe" %*',
    ''
  ) -join "`r`n"
  Set-Content -Path $oldCmd -Value $cmd -Encoding ASCII

  if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $parts = @()
    if ($userPath) { $parts = $userPath -split ';' | Where-Object { $_ } }
    if ($parts -notcontains $bin) {
      $next = (@($parts) + $bin) -join ';'
      [Environment]::SetEnvironmentVariable("Path", $next, "User")
      Write-Host "    Added $bin to the user PATH"
    }
  }

  if (-not $NoShortcut) {
    $startMenu = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"
    New-Item -ItemType Directory -Force -Path $startMenu | Out-Null
    $shortcut = Join-Path $startMenu "Agent-1.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut($shortcut)
    $link.TargetPath = Join-Path $current "agent-1.exe"
    $link.WorkingDirectory = $current
    $link.IconLocation = (Join-Path $current "agent-1.exe") + ",0"
    $link.Description = "Agent-1 local personal assistant"
    $link.Save()
    Write-Host "    Created Start Menu shortcut"
  }

  if (-not (Get-Command git.exe -ErrorAction SilentlyContinue)) {
    Write-Warning "Git for Windows was not found. Filesystem checkpoints require git.exe on PATH."
  }

  if (-not $NoOnboard) {
    Write-Step "Starting Agent-1"
    & cmd.exe /c "`"$oldCmd`" onboard"
  }

  $enable = $false
  if ($EnableAutostart) {
    $enable = $true
  } elseif (-not $NoAutostart -and $Host.Name -eq "ConsoleHost") {
    $answer = Read-Host "Start Agent-1 automatically at Windows sign-in? [y/N]"
    if ($answer -match '^(y|yes)$') { $enable = $true }
  }
  if ($enable) {
    & cmd.exe /c "`"$oldCmd`" service autostart on"
  }

  Write-Host ""
  Write-Host "Agent-1 $Version installed."
  Write-Host "  Command: agent-1"
  Write-Host "  Install: $InstallDir"
  Write-Host "  Web UI:  http://127.0.0.1:28895"
  Write-Host ""
  Write-Host "Open a new terminal if 'agent-1' is not yet available in this session."
} finally {
  Remove-Item -Recurse -Force $tempRoot -ErrorAction SilentlyContinue
}
