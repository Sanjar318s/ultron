# Scans installed Windows apps and writes their friendly names + launch targets
# to a UTF-8 JSON file. Output shape: { generatedAt, apps: [{name,path,kind}] }
# kind: "shortcut" (Start Menu .lnk) or "apppath" (registry App Paths).
param(
    [Parameter(Mandatory = $true)]
    [string]$OutFile
)

$ErrorActionPreference = "SilentlyContinue"

$apps = @()

# 1. Start Menu shortcuts — the names the user actually sees.
$startDirs = @(
    "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
    "$env:APPDATA\Microsoft\Windows\Start Menu\Programs"
)
foreach ($dir in $startDirs) {
    if (-not (Test-Path -LiteralPath $dir)) { continue }
    Get-ChildItem -LiteralPath $dir -Filter *.lnk -Recurse | ForEach-Object {
        $apps += [PSCustomObject]@{
            name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
            path = $_.FullName
            kind = "shortcut"
        }
    }
}

# 2. Registry App Paths — executables with registered paths.
$regRoots = @(
    "Registry::HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths",
    "Registry::HKEY_CURRENT_USER\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths"
)
foreach ($root in $regRoots) {
    Get-ChildItem -Path $root | ForEach-Object {
        $exe = $_.PSChildName
        $target = $_.GetValue("")
        if ($exe -and $target) {
            $apps += [PSCustomObject]@{
                name = [System.IO.Path]::GetFileNameWithoutExtension($exe)
                path = [string]$target
                kind = "apppath"
            }
        }
    }
}

$out = @{ generatedAt = (Get-Date -Format o); apps = $apps } | ConvertTo-Json -Depth 3
Set-Content -LiteralPath $OutFile -Value $out -Encoding UTF8
