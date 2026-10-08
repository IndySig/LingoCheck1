# Install a portable JRE + Okapi apps into .tools/ for LingoCheck.
param(
  [string]$OkapiVersion = "1.48.0"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root ".tools"
New-Item -ItemType Directory -Force -Path $Tools | Out-Null

function Write-Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- Java (Eclipse Temurin 17 JRE) ---
$JavaHome = Join-Path $Tools "jre"
$JavaExe = Join-Path $JavaHome "bin\java.exe"
if (-not (Test-Path -LiteralPath $JavaExe)) {
  Write-Step "Downloading Eclipse Temurin 17 JRE..."
  $jreZip = Join-Path $Tools "temurin-jre17.zip"
  $jreUrl = "https://api.adoptium.net/v3/binary/latest/17/ga/windows/x64/jre/hotspot/normal/eclipse?project=jdk"
  Invoke-WebRequest -Uri $jreUrl -OutFile $jreZip -UseBasicParsing
  $jreExtract = Join-Path $Tools "jre-extract"
  if (Test-Path $jreExtract) { Remove-Item -Recurse -Force $jreExtract }
  Expand-Archive -LiteralPath $jreZip -DestinationPath $jreExtract -Force
  $nested = Get-ChildItem -Path $jreExtract -Directory | Select-Object -First 1
  if (-not $nested) { throw "JRE archive had no directory" }
  if (Test-Path $JavaHome) { Remove-Item -Recurse -Force $JavaHome }
  Move-Item -LiteralPath $nested.FullName -Destination $JavaHome
  Remove-Item -Force $jreZip -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $jreExtract -ErrorAction SilentlyContinue
} else {
  Write-Step "JRE already present at $JavaHome"
}

& $JavaExe -version

# --- Okapi apps ---
$OkapiHome = Join-Path $Tools "okapi"
$Tikal = Join-Path $OkapiHome "tikal.bat"
if (-not (Test-Path -LiteralPath $Tikal)) {
  Write-Step "Downloading Okapi apps $OkapiVersion..."
  $okZip = Join-Path $Tools "okapi-apps.zip"
  $okUrl = "https://okapiframework.org/binaries/main/$OkapiVersion/okapi-apps_win32-x86_64_$OkapiVersion.zip"
  Invoke-WebRequest -Uri $okUrl -OutFile $okZip -UseBasicParsing
  $okExtract = Join-Path $Tools "okapi-extract"
  if (Test-Path $okExtract) { Remove-Item -Recurse -Force $okExtract }
  Expand-Archive -LiteralPath $okZip -DestinationPath $okExtract -Force
  # Newer Windows zips unpack flat; older ones nest one folder.
  $sourceDir = $null
  if (Test-Path (Join-Path $okExtract "tikal.bat")) {
    $sourceDir = $okExtract
  } else {
    $nested = Get-ChildItem -Path $okExtract -Directory | Where-Object {
      Test-Path (Join-Path $_.FullName "tikal.bat")
    } | Select-Object -First 1
    if ($nested) { $sourceDir = $nested.FullName }
  }
  if (-not $sourceDir -or -not (Test-Path (Join-Path $sourceDir "tikal.bat"))) {
    throw "Okapi archive missing tikal.bat"
  }
  if (Test-Path $OkapiHome) { Remove-Item -Recurse -Force $OkapiHome }
  if ($sourceDir -eq $okExtract) {
    New-Item -ItemType Directory -Force -Path $OkapiHome | Out-Null
    Get-ChildItem -Path $okExtract -Force | ForEach-Object {
      Move-Item -LiteralPath $_.FullName -Destination (Join-Path $OkapiHome $_.Name) -Force
    }
    Remove-Item -Recurse -Force $okExtract -ErrorAction SilentlyContinue
  } else {
    Move-Item -LiteralPath $sourceDir -Destination $OkapiHome
    Remove-Item -Recurse -Force $okExtract -ErrorAction SilentlyContinue
  }
  Remove-Item -Force $okZip -ErrorAction SilentlyContinue
} else {
  Write-Step "Okapi already present at $OkapiHome"
}

Write-Step "Verifying Tikal..."
$env:JAVA_HOME = $JavaHome
$env:PATH = (Join-Path $JavaHome "bin") + ";" + $env:PATH
& cmd.exe /d /s /c "`"$Tikal`" -h" | Select-Object -First 8

Write-Host "`nOkapi setup complete." -ForegroundColor Green
Write-Host "  JAVA_HOME=$JavaHome"
Write-Host "  OKAPI_HOME=$OkapiHome"
Write-Host "Restart LingoCheck (start-lingocheck.ps1) so the server picks this up."
