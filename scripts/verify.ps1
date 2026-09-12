<#
.SYNOPSIS
  Local verification for ReproAgent on Windows / PowerShell.

.DESCRIPTION
  No CI pipeline is configured in this repository. This script is the authoritative verification
  sequence, run locally in one command; it previously mirrored the removed .gitlab-ci.yml pipeline.

  Every stage here is deterministic: no DeepSeek variable is read, and the script actively CLEARS
  them for the browser stages so that an accidental dependency on AI configuration surfaces as a
  failure here rather than in a later milestone (docs/m0-decisions.md, decision 6).

.PARAMETER Gate
  Also run the reliability gate twice sequentially. Adds roughly 12-15 minutes.

.PARAMETER SkipBrowser
  Skip every stage that needs Chromium. Useful on a machine without the browser downloaded.

.EXAMPLE
  pwsh -File scripts/verify.ps1
  pwsh -File scripts/verify.ps1 -Gate
#>
[CmdletBinding()]
param(
  [switch]$Gate,
  [switch]$SkipBrowser
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot

$script:Failures = @()

function Invoke-Stage {
  param(
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][scriptblock]$Action
  )
  Write-Host ""
  Write-Host "=== $Name " -NoNewline -ForegroundColor Cyan
  Write-Host ("=" * [Math]::Max(0, 60 - $Name.Length)) -ForegroundColor Cyan
  $started = Get-Date
  try {
    & $Action
    # Native commands do not throw; their exit code is the verdict.
    if ($LASTEXITCODE -ne 0) {
      throw "$Name exited with code $LASTEXITCODE"
    }
    $elapsed = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Write-Host "PASS  $Name  (${elapsed}s)" -ForegroundColor Green
  } catch {
    $elapsed = [Math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    Write-Host "FAIL  $Name  (${elapsed}s): $_" -ForegroundColor Red
    $script:Failures += $Name
  }
}

function Clear-AiEnvironment {
  # Deterministic stages must not need these. Clearing them proves it instead of assuming it.
  foreach ($name in @(
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_BASE_URL',
      'DEEPSEEK_FAST_MODEL',
      'DEEPSEEK_REASONING_MODEL',
      'DEEPSEEK_FALLBACK_MODEL'
    )) {
    Remove-Item "env:$name" -ErrorAction SilentlyContinue
  }
}

Write-Host "ReproAgent local verification" -ForegroundColor White
Write-Host "Repository: $repoRoot"
Write-Host "Node:       $(node --version)"
Write-Host "Platform:   $($PSVersionTable.Platform) / PowerShell $($PSVersionTable.PSVersion)"

Invoke-Stage 'build' { npm run build }
Invoke-Stage 'lint' { npm run lint }
Invoke-Stage 'format:check' { npm run format:check }
Invoke-Stage 'typecheck' { npm run typecheck }

Invoke-Stage 'frozen Prompt A checksum' {
  # Byte-for-byte, and specifically meaningful on Windows: without `.gitattributes` marking the
  # file `-text`, a checkout here would rewrite LF to CRLF and invalidate the checksum.
  Push-Location (Join-Path $repoRoot 'docs')
  try {
    $expected = ((Get-Content -Raw 'prompt-a.sha256') -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 'prompt-a.txt').Hash.ToLower()
    if ($expected -ne $actual) {
      throw "prompt-a.txt checksum mismatch: expected $expected, got $actual"
    }
    Write-Host "  prompt-a.txt: OK ($actual)"
    $global:LASTEXITCODE = 0
  } finally {
    Pop-Location
  }
}

Invoke-Stage 'docs and schema invariants' { npm run test:docs }
Invoke-Stage 'unit tests' { npm test }

if ($SkipBrowser) {
  Write-Host ""
  Write-Host "Skipping browser stages (-SkipBrowser)." -ForegroundColor Yellow
} else {
  Clear-AiEnvironment
  Invoke-Stage 'CLI end-to-end tests' { npm run test:e2e }

  Invoke-Stage 'documented M1 demo (no AI configuration)' {
    $ws = Join-Path ([System.IO.Path]::GetTempPath()) ("reproagent-demo-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
      node apps/cli/dist/bin.js init --workspace $ws --json | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "init failed" }
      node apps/cli/dist/bin.js run --workspace $ws `
        --fixture-experiment packages/test-fixtures/experiments/product-failing-intermittent.json `
        --fixture-app product-failing-intermittent --repeat 4 --json | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "run failed" }
      node apps/cli/dist/bin.js doctor --workspace $ws --json | Out-Null
    } finally {
      Remove-Item -Recurse -Force $ws -ErrorAction SilentlyContinue
    }
  }

  if ($Gate) {
    Invoke-Stage 'reliability gate, twice sequentially' {
      New-Item -ItemType Directory -Force -Path (Join-Path $repoRoot 'ci-diagnostics') | Out-Null
      npm run gate:twice 2>&1 | Tee-Object -FilePath (Join-Path $repoRoot 'ci-diagnostics/reliability-gate.log')
    }
  } else {
    Write-Host ""
    Write-Host "Reliability gate not run. Add -Gate to include it." -ForegroundColor Yellow
  }
}

Pop-Location

Write-Host ""
if ($script:Failures.Count -eq 0) {
  Write-Host "All stages passed." -ForegroundColor Green
  exit 0
}
Write-Host "FAILED stages: $($script:Failures -join ', ')" -ForegroundColor Red
exit 1
