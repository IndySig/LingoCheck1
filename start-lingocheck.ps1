param(
  [int]$Port = 5001
)

$ErrorActionPreference = "Stop"

function Stop-PortListener([int]$p) {
  $lines = netstat -ano | Select-String (":$p\s") | ForEach-Object { $_.Line }
  foreach ($l in $lines) {
    if ($l -match "\sLISTENING\s+(\d+)$") {
      $procId = [int]$Matches[1]
      try { Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

function Resolve-NodeExe {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Source) { return $cmd.Source }

  $candidates = @(
    "$env:ProgramFiles\nodejs\node.exe",
    "${env:ProgramFiles(x86)}\nodejs\node.exe",
    "$env:LOCALAPPDATA\Programs\nodejs\node.exe",
    "$env:ProgramFiles\cursor\resources\app\resources\helpers\node.exe",
    "$env:LOCALAPPDATA\Programs\cursor\resources\app\resources\helpers\node.exe"
  )
  foreach ($path in $candidates) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }

  throw "Node.js was not found. Install it from https://nodejs.org (LTS) and reopen the terminal."
}

Stop-PortListener -p $Port

$env:PORT = "$Port"
Set-Location $PSScriptRoot

# Prefer local portable JRE / Okapi from scripts/setup-okapi.ps1
$localJre = Join-Path $PSScriptRoot ".tools\jre"
$localJava = Join-Path $localJre "bin\java.exe"
if (Test-Path -LiteralPath $localJava) {
  $env:JAVA_HOME = $localJre
  $env:PATH = (Join-Path $localJre "bin") + ";" + $env:PATH
}
$localOkapi = Join-Path $PSScriptRoot ".tools\okapi"
if (Test-Path -LiteralPath (Join-Path $localOkapi "tikal.bat")) {
  $env:OKAPI_HOME = $localOkapi
}

$nodeExe = Resolve-NodeExe
& $nodeExe ".\server.js"

