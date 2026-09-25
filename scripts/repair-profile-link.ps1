#!/usr/bin/env pwsh
# Repairs the dsh-sub-providers junction in the web profile after pnpm
# rewrites it (pnpm joins absolute link targets onto the profile dir on
# Windows). Run after any `dsh plugin --profile web ...` command when the
# plugin is installed as a local development link.
param(
  [string]$Target = (Join-Path (Get-Location) 'dsh-sub-providers'),
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\web')
)
$link = Join-Path $ProfileDir 'node_modules\dsh-sub-providers'
if (Test-Path $link) { Remove-Item $link -Force }
New-Item -ItemType Junction -Path $link -Target $Target | Out-Null
Write-Host "junction repaired -> $Target"
