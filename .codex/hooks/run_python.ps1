param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("session_start.py", "pre_tool_use.py")]
    [string]$HookName
)

$ErrorActionPreference = "Stop"
$hookDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$hookScript = Join-Path $hookDirectory $HookName

function Invoke-UsablePython {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Executable,
        [string[]]$PrefixArguments = @()
    )

    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) {
        return
    }
    & $Executable @PrefixArguments -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)" *> $null
    if ($LASTEXITCODE -ne 0) {
        return
    }
    & $Executable @PrefixArguments $hookScript
    exit $LASTEXITCODE
}

if ($env:PROJECT_GOVERNANCE_PYTHON) {
    Invoke-UsablePython -Executable $env:PROJECT_GOVERNANCE_PYTHON
}

$pathPython = Get-Command python3 -CommandType Application -ErrorAction SilentlyContinue
if ($pathPython) {
    Invoke-UsablePython -Executable $pathPython.Source
}

$pythonLauncher = Get-Command py -CommandType Application -ErrorAction SilentlyContinue
if ($pythonLauncher) {
    Invoke-UsablePython -Executable $pythonLauncher.Source -PrefixArguments @("-3")
}

$bundledCandidates = @(
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"),
    (Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\python\bin\python3.exe")
)
foreach ($candidate in $bundledCandidates) {
    Invoke-UsablePython -Executable $candidate
}

Write-Error "No usable Python 3.9+ runtime found. Set PROJECT_GOVERNANCE_PYTHON."
exit 69
