$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendPath = Join-Path $ProjectRoot 'backend'

if (-not (Test-Path -LiteralPath (Join-Path $BackendPath 'node_modules'))) {
    Write-Host '首次运行，正在安装后端依赖...'
    npm install --prefix $BackendPath
}

Write-Host '正在启动 AI 任务分解系统...'
Write-Host '浏览器访问：http://localhost:3200'
npm start --prefix $BackendPath
