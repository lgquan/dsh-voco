$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $prototypeRoot '.cache\uv-tts'
$env:HF_HOME = Join-Path $prototypeRoot '.cache\huggingface'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $prototypeRoot '.cache\huggingface\hub'
$env:MODELSCOPE_CACHE = Join-Path $prototypeRoot '.cache\modelscope'
$env:TORCH_HOME = Join-Path $prototypeRoot '.cache\torch'
$env:PYTHONUTF8 = '1'

& (Join-Path $prototypeRoot 'setup-tts.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$python = Join-Path $prototypeRoot '.venv-tts\Scripts\python.exe'
& $python (Join-Path $prototypeRoot 'benchmark_tts.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

