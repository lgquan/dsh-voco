$ErrorActionPreference = 'Stop'

$speechRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $speechRoot
$venvRoot = Join-Path $speechRoot '.venv'
$python = Join-Path $venvRoot 'Scripts\python.exe'
$cacheRoot = Join-Path $speechRoot '.cache'
$runtimeRoot = Join-Path $speechRoot 'moss_tts_runtime'
$modelRoot = Join-Path $runtimeRoot 'models'
$requirements = Join-Path $speechRoot 'requirements.txt'

New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
$env:MODELSCOPE_CACHE = Join-Path $cacheRoot 'modelscope'
$env:MODELSCOPE_HOME = $env:MODELSCOPE_CACHE
$env:TORCH_HOME = Join-Path $cacheRoot 'torch'
$env:HF_HOME = Join-Path $cacheRoot 'huggingface'
$env:HUGGINGFACE_HUB_CACHE = Join-Path $env:HF_HOME 'hub'

function Invoke-Checked([string] $File, [string[]] $Arguments) {
  & $File @Arguments
  if ($LASTEXITCODE -ne 0) { throw "command failed ($LASTEXITCODE): $File $($Arguments -join ' ')" }
}

if (-not (Test-Path -LiteralPath $python)) {
  if (Get-Command uv -ErrorAction SilentlyContinue) {
    Invoke-Checked 'uv' @('venv', '--python', '3.10', $venvRoot)
  } else {
    $launcher = Get-Command py -ErrorAction SilentlyContinue
    if ($null -eq $launcher) { throw 'Python 3.10 or uv is required. Install uv from https://docs.astral.sh/uv/.' }
    Invoke-Checked $launcher.Source @('-3.10', '-m', 'venv', $venvRoot)
  }
}
if (-not (Test-Path -LiteralPath $python)) { throw "Python environment was not created: $python" }

if (Get-Command uv -ErrorAction SilentlyContinue) {
  Invoke-Checked 'uv' @('pip', 'install', '--python', $python, '-r', $requirements)
} else {
  Invoke-Checked $python @('-m', 'pip', 'install', '--upgrade', 'pip')
  Invoke-Checked $python @('-m', 'pip', 'install', '-r', $requirements)
}

$env:DSH_MOSS_TTS_ROOT = $runtimeRoot
$env:DSH_MOSS_MODEL_DIR = $modelRoot
New-Item -ItemType Directory -Force -Path $modelRoot | Out-Null

Write-Host 'Preparing FunASR model cache...'
@'
from funasr import AutoModel
AutoModel(model="paraformer-zh-streaming", device="cpu", disable_update=True, disable_pbar=True)
print("FunASR cache ready")
'@ | & $python -
if ($LASTEXITCODE -ne 0) { throw 'FunASR model preparation failed' }

Write-Host 'Preparing MOSS-TTS-Nano ONNX model cache...'
@"
import sys
sys.path.insert(0, r'$runtimeRoot')
from onnx_tts_runtime import OnnxTtsRuntime
OnnxTtsRuntime(model_dir=r'$env:DSH_MOSS_MODEL_DIR', thread_count=4, execution_provider='cpu')
print('MOSS-TTS-Nano cache ready')
"@ | & $python -
if ($LASTEXITCODE -ne 0) { throw 'MOSS-TTS-Nano model preparation failed' }

Write-Host ''
Write-Host 'Local voice models are ready.'
Write-Host "Python: $python"
Write-Host "Cache:  $cacheRoot"
