param(
  [Parameter(Mandatory = $true)]
  [string]$Worktree,
  [string]$RunLabel = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$worktreeRoot = (Resolve-Path $Worktree).Path
Set-Location $worktreeRoot
if (-not $RunLabel) {
  $RunLabel = git rev-parse --short=12 HEAD
  if ($LASTEXITCODE -ne 0) {
    throw 'cannot derive measurement label from the target worktree HEAD'
  }
}

$env:SHIFU_CACHE_PROFILE_REF = 'docs/shifu/qualification-portable-off.cache-profile.json'
$env:SHIFU_CACHE_PROFILE_DIGEST = 'sha256:251ecdb33a34b770a6fbd40b0b05c5c8c0d629a06d9144e6d2d89c9c8e70258b'
$env:SHIFU_CACHE_SCOPE = 'self-hosted-runner'
$env:KUNGFU_BUILDCHAIN_NO_OPTIONAL = '1'
$env:KUNGFU_BUILDCHAIN_SOURCE_BUILD = '1'
$env:SHIFU_NATIVE = '1'
$env:SHIFU_REQUIRE_MSVC = '1'
$env:CCACHE_DISABLE = '1'
$env:KUNGFU_FUZZ_SECONDS = '90'

$out = Join-Path $worktreeRoot ".buildchain\measurements\windows-$RunLabel"
$utf8 = [System.Text.UTF8Encoding]::new($false)
$newline = [System.Environment]::NewLine

New-Item -ItemType Directory -Force -Path $out | Out-Null

function Invoke-TimedStage {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  Write-Output "START $Name"
  $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $previousErrorAction = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & fnm @Arguments > "$out\$Name.stdout.log" 2> "$out\$Name.stderr.log"
  $status = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorAction
  $stopwatch.Stop()

  [System.IO.File]::WriteAllText(
    "$out\$Name.time",
    (("real {0:F3}" -f $stopwatch.Elapsed.TotalSeconds) + $newline),
    $utf8
  )
  [System.IO.File]::WriteAllText("$out\$Name.exit", "$status$newline", $utf8)
  Write-Output ("END {0} rc={1} real={2:F3}" -f $Name, $status, $stopwatch.Elapsed.TotalSeconds)

  if ($status -ne 0) {
    [System.IO.File]::WriteAllText("$out\FAILED", "failed $Name rc=$status$newline", $utf8)
    exit $status
  }
}

$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor
$preflight = @(
  "hostname=$env:COMPUTERNAME"
  "os=$([System.Environment]::OSVersion.VersionString)"
  "os_caption=$($os.Caption)"
  "os_version=$($os.Version)"
  "os_build=$($os.BuildNumber)"
  "memory_total_kib=$($os.TotalVisibleMemorySize)"
  "memory_free_kib=$($os.FreePhysicalMemory)"
  "cpu=$($cpu.Name)"
  "cpu_cores=$($cpu.NumberOfCores)"
  "cpu_logical=$($cpu.NumberOfLogicalProcessors)"
  "source_sha=$(git rev-parse HEAD)"
  (Get-FileHash -Algorithm SHA256 shifu.gates.json | ForEach-Object { "shifu.gates.json sha256=$($_.Hash.ToLower())" })
  (Get-FileHash -Algorithm SHA256 docs\shifu\qualification-portable-off.cache-profile.json | ForEach-Object { "cache_profile sha256=$($_.Hash.ToLower())" })
  (Get-FileHash -Algorithm SHA256 .buildchain\contract-lock.json | ForEach-Object { "contract_lock sha256=$($_.Hash.ToLower())" })
  "fnm=$(fnm --version)"
  "node=$(fnm exec -- node --version)"
  "pnpm=$(fnm exec -- cmd.exe /d /s /c 'corepack pnpm --version')"
  "uv=$(uv --version)"
  "cmake=$(cmake --version | Select-Object -First 1)"
  "cl=$(cmd.exe /d /s /c 'where cl 2>&1')"
  "cargo=$(cargo --version)"
  "SHIFU_CACHE_PROFILE_REF=$env:SHIFU_CACHE_PROFILE_REF"
  "SHIFU_CACHE_PROFILE_DIGEST=$env:SHIFU_CACHE_PROFILE_DIGEST"
  "SHIFU_CACHE_SCOPE=$env:SHIFU_CACHE_SCOPE"
  "KUNGFU_BUILDCHAIN_NO_OPTIONAL=$env:KUNGFU_BUILDCHAIN_NO_OPTIONAL"
  "KUNGFU_BUILDCHAIN_SOURCE_BUILD=$env:KUNGFU_BUILDCHAIN_SOURCE_BUILD"
  "SHIFU_NATIVE=$env:SHIFU_NATIVE"
  "SHIFU_REQUIRE_MSVC=$env:SHIFU_REQUIRE_MSVC"
  "CCACHE_DISABLE=$env:CCACHE_DISABLE"
  "KUNGFU_FUZZ_SECONDS=$env:KUNGFU_FUZZ_SECONDS"
  "KUNGFU_BUILD_JOBS=$env:KUNGFU_BUILD_JOBS"
  'git_status_begin'
  (git status --short)
  'git_status_end'
)
[System.IO.File]::WriteAllLines("$out\preflight.log", $preflight, $utf8)

Invoke-TimedStage 'install' @('exec', '--', 'node', 'scripts/buildchain-install.mjs')
Invoke-TimedStage 'dist' @('exec', '--', 'node', 'scripts/run-shifu-lifecycle.mjs', 'cache-apply', 'dist')
Invoke-TimedStage 'verify-fuzz' @('exec', '--', 'node', 'scripts/run-shifu-lifecycle.mjs', 'cache-apply', 'verify', '--fuzz')
Invoke-TimedStage 'layer-gates' @(
  'exec', '--', 'node', 'scripts/run-shifu-lifecycle.mjs', 'cache-apply',
  'gate', 'run', 'layers.format', 'layers.sdk', 'layers.surfaces',
  '--capability', 'node',
  '--capability', 'native-toolchain',
  '--capability', 'product-artifacts',
  '--capability', 'rust',
  '--receipt', 'product/release/qualification/layer-artifact-gate-receipt.json',
  '--overwrite'
)

$postflight = @(
  'git_status_begin'
  (git status --short)
  'git_status_end'
)
Get-ChildItem product\release\qualification -File -Recurse |
  Sort-Object FullName |
  ForEach-Object { $postflight += "$($_.FullName) $($_.Length) bytes" }
$postflight += Get-FileHash -Algorithm SHA256 product\release\qualification\layer-artifact-gate-receipt.json |
  ForEach-Object { "receipt sha256=$($_.Hash.ToLower())" }
[System.IO.File]::WriteAllLines("$out\postflight.log", $postflight, $utf8)
[System.IO.File]::WriteAllText("$out\DONE", "complete$newline", $utf8)
Write-Output 'COMPLETE'
