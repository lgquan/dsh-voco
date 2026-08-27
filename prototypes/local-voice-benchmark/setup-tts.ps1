$ErrorActionPreference = 'Stop'
$prototypeRoot = $PSScriptRoot
$venvPython = Join-Path $prototypeRoot '.venv-tts\Scripts\python.exe'
$marker = Join-Path $prototypeRoot '.venv-tts\.dsh-live-ready'
$env:UV_CACHE_DIR = Join-Path $prototypeRoot '.cache\uv-tts'
$env:HF_HOME = Join-Path $prototypeRoot '.cache\huggingface'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $prototypeRoot '.cache\huggingface\hub'
$env:MODELSCOPE_CACHE = Join-Path $prototypeRoot '.cache\modelscope'
$env:TORCH_HOME = Join-Path $prototypeRoot '.cache\torch'
$env:PYTHONUTF8 = '1'

if (Test-Path -LiteralPath $marker) {
  Write-Host 'CosyVoice CPU environment is already ready.'
  exit 0
}

Push-Location $prototypeRoot
try {
  if (-not (Test-Path -LiteralPath $venvPython)) {
    uv venv --python 3.10 .venv-tts
    if ($LASTEXITCODE -ne 0) { throw 'failed to create CosyVoice virtual environment' }
  }
  uv pip install --python $venvPython torch==2.3.1 torchaudio==2.3.1 --index-url https://download.pytorch.org/whl/cpu
  if ($LASTEXITCODE -ne 0) { throw 'failed to install CPU PyTorch' }
  uv pip install --python $venvPython setuptools==80.9.0 wheel
  if ($LASTEXITCODE -ne 0) { throw 'failed to install CosyVoice build tools' }
  uv pip install --python $venvPython openai-whisper==20231117 --no-build-isolation
  if ($LASTEXITCODE -ne 0) { throw 'failed to install openai-whisper compatibility dependency' }
  uv pip install --python $venvPython -r requirements-tts-windows-cpu.txt
  if ($LASTEXITCODE -ne 0) { throw 'failed to install CosyVoice CPU dependencies' }
  New-Item -ItemType File -Force -Path $marker | Out-Null
}
finally {
  Pop-Location
}
