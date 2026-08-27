$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$python = Join-Path $prototypeRoot '.venv-moss-tts\Scripts\python.exe'
$env:UV_CACHE_DIR = Join-Path $prototypeRoot '.cache\uv-moss-tts'
$env:HF_HOME = Join-Path $prototypeRoot '.cache\huggingface-moss-tts'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $prototypeRoot '.cache\huggingface-moss-tts\hub'

Push-Location $prototypeRoot
try {
  if (-not (Test-Path -LiteralPath $python)) {
    uv venv --python 3.10 .venv-moss-tts
    if ($LASTEXITCODE -ne 0) { throw 'failed to create MOSS-TTS-Nano environment' }
  }
  uv pip install --python $python -r requirements-moss-tts-onnx.txt
  if ($LASTEXITCODE -ne 0) { throw 'failed to install MOSS-TTS-Nano ONNX dependencies' }
}
finally {
  Pop-Location
}
