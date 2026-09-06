$ErrorActionPreference = 'Stop'
node (Join-Path $PSScriptRoot 'pack.mjs')
