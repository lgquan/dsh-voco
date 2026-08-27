param(
  [Parameter(Position = 0)]
  [ValidateSet('system', 'devices', 'record', 'vad', 'asr', 'all')]
  [string]$Action = 'system',

  [Parameter(Position = 1)]
  [string]$InputPath = '',

  [int]$Seconds = 10
)

$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $prototypeRoot '.cache\uv'
$env:UV_PROJECT_ENVIRONMENT = Join-Path $prototypeRoot '.venv-asr'
$env:HF_HOME = Join-Path $prototypeRoot '.cache\huggingface'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $prototypeRoot '.cache\huggingface\hub'
$env:MODELSCOPE_CACHE = Join-Path $prototypeRoot '.cache\modelscope'
$env:TORCH_HOME = Join-Path $prototypeRoot '.cache\torch'
$env:PYTHONUTF8 = '1'

Push-Location $prototypeRoot
try {
  uv sync --python 3.10
  $arguments = @('run', '--no-sync', 'python', 'benchmark.py', $Action)
  if ($InputPath -ne '') { $arguments += @('--input', $InputPath) }
  if ($Action -eq 'record') { $arguments += @('--seconds', [string]$Seconds) }
  & uv @arguments
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
}
