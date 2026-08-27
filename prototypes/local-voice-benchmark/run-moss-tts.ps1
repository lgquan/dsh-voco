$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$env:UV_CACHE_DIR = Join-Path $prototypeRoot '.cache\uv-moss-tts'
$env:HF_HOME = Join-Path $prototypeRoot '.cache\huggingface-moss-tts'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $prototypeRoot '.cache\huggingface-moss-tts\hub'
$env:PYTHONUTF8 = '1'

& (Join-Path $prototypeRoot 'setup-moss-tts.ps1')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$python = Join-Path $prototypeRoot '.venv-moss-tts\Scripts\python.exe'
& $python (Join-Path $prototypeRoot 'benchmark_moss_tts.py')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
