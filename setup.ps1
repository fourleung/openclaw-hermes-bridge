$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

npm install
npm run build

$hasPackageRef = $false
foreach ($arg in $args) {
  if ($arg -eq "--package-ref") {
    $hasPackageRef = $true
    break
  }
}

if ($hasPackageRef) {
  node dist/cli.js setup @args
} else {
  $packageTgz = (npm pack --silent | Select-Object -Last 1)
  try {
    node dist/cli.js setup --package-ref "file:$scriptDir/$packageTgz" @args
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $scriptDir $packageTgz)
  }
}
