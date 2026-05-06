param(
  [int]$Port = 5001
)

$ErrorActionPreference = "Stop"

function Stop-PortListener([int]$p) {
  $lines = netstat -ano | Select-String (":$p\s") | ForEach-Object { $_.Line }
  foreach ($l in $lines) {
    if ($l -match "\sLISTENING\s+(\d+)$") {
      $pid = [int]$Matches[1]
      try { Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } catch {}
    }
  }
}

Stop-PortListener -p $Port

$env:PORT = "$Port"
Set-Location $PSScriptRoot
node ".\server.js"

