#!/usr/bin/env pwsh
# Repairs a local-development install of dsh-sub-providers in a DSH profile:
#   1. the node_modules junction — pnpm joins absolute link targets onto the
#      profile directory on Windows, producing a link that resolves nowhere;
#   2. the dsh.profile.bundles entry — pnpm reconcile prunes the package from
#      the bundle list while its junction is broken.
# Run after any `dsh plugin --profile web ...` command when the plugin is
# installed as a local development link.
param(
  [string]$Target = (Join-Path (Get-Location) 'dsh-sub-providers'),
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web')
)
$link = Join-Path $ProfileDir 'node_modules\dsh-sub-providers'
if (Test-Path $link) { Remove-Item $link -Force }
New-Item -ItemType Junction -Path $link -Target $Target | Out-Null
Write-Host "junction repaired -> $Target"

$manifest = Join-Path $ProfileDir 'package.json'
$pkg = Get-Content $manifest -Raw | ConvertFrom-Json
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-sub-providers') {
  $pkg.dsh.profile.bundles = @($bundles + 'dsh-sub-providers')
  $pkg | ConvertTo-Json -Depth 10 | Set-Content $manifest -Encoding UTF8
  Write-Host "bundle entry restored -> $manifest"
} else {
  Write-Host "bundle entry present"
}
