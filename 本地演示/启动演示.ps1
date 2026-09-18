$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot -Parent
$localDir = Join-Path $projectRoot '.local'
$logDir = Join-Path $localDir 'setup'
$dotnet = Join-Path $localDir 'dotnet\dotnet.exe'
$python = 'C:\Users\gao\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$dll = Join-Path $projectRoot '调研\DWSIM源码解读\source\dwsim10\tools\DWSIM.MCPServer\bin\Release\net10.0\dwsim-mcp.dll'
$server = Join-Path $PSScriptRoot 'server.py'
foreach ($required in @($dotnet,$python,$dll,$server)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Missing required file: $required" }
}
function Start-LocalService($port, $expectedPath, $executable, $arguments, $workingDir, $name) {
    $listeners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        foreach ($listener in $listeners) {
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
            if (-not $proc.CommandLine -and $name -eq 'mcp') {
                $rpc = Invoke-RestMethod -Uri 'http://localhost:15901/mcp' -Method Post -ContentType 'application/json' -Headers @{'X-MCP-Token'=$token} -Body '{"jsonrpc":"2.0","id":"startup","method":"tools/list","params":{}}' -TimeoutSec 10
                if (-not ($rpc.result.tools.name -contains 'dwsim_flowsheet_create')) { throw 'Existing MCP service identity check failed.' }
                continue
            }
            if (-not $proc.CommandLine -or -not $proc.CommandLine.Contains($expectedPath)) {
                throw "Port $port is occupied by another service. No process was stopped."
            }
        }
        return
    }
    $proc = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $workingDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir "$name.stdout.log") -RedirectStandardError (Join-Path $logDir "$name.stderr.log")
    $proc.Id | Set-Content -LiteralPath (Join-Path $localDir "$name.pid")
    for ($i=0; $i -lt 30; $i++) {
        if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { return }
        Start-Sleep -Milliseconds 500
        if ($proc.HasExited) { throw "$name exited. See logs in $logDir" }
    }
    throw "$name startup timed out. See logs in $logDir"
}
$tokenPath = Join-Path $localDir 'mcp-token.txt'
if (-not (Test-Path -LiteralPath $tokenPath)) { [guid]::NewGuid().ToString('N') | Set-Content -LiteralPath $tokenPath }
$token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
Start-LocalService 15901 $dll $dotnet ('"' + $dll + '" --http --host localhost --port 15901 --token ' + $token) (Split-Path $dll -Parent) 'mcp'
Start-LocalService 18765 $server $python ('"' + $server + '"') $PSScriptRoot 'web'
$status = Invoke-RestMethod -Uri 'http://127.0.0.1:18765/api/status' -TimeoutSec 15
if (-not $status.ok) { throw 'DWSIM health check failed.' }
Write-Host "DWSIM online: $($status.tools) tools"
Write-Host 'Open http://127.0.0.1:18765/ in your browser.'
