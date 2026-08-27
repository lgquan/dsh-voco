# dsh-live local speech worker

The worker is a long-lived JSON-lines process used by voice-local.

Input messages:

- audio: base64 PCM16 mono 16 kHz
- commit
- synthesize with responseId and text
- interrupt
- close

Output is newline-delimited JSON containing readiness, transcription, streamed
PCM16 TTS chunks, errors, and close events. Models are loaded once per worker.
The repository includes the small MOSS ONNX runtime adapter under
`speech/moss_tts_runtime`. Set `DSH_MOSS_TTS_ROOT` (or pass `--tts-root`) only
when replacing it with another compatible checkout. Set `DSH_MOSS_MODEL_DIR` (or
pass `--model-dir`) to the external ONNX model directory. Runtime source is
committed; model weights are not.

ModelScope, Torch, and Hugging Face caches are redirected to `speech/.cache`
by default. Since this repository is on D:, model downloads do not consume the
system drive.

Install the speech environment separately from the Node workspace:

    uv venv --python 3.10 .venv-speech
    uv pip install --python .venv-speech\Scripts\python.exe -r speech\requirements.txt

Development example:

    $env:DSH_MOSS_TTS_ROOT = "$PWD\prototypes\local-voice-benchmark\vendor\MOSS-TTS-Nano"
    $env:DSH_MOSS_MODEL_DIR = "$env:DSH_MOSS_TTS_ROOT\models"
    .\.venv-speech\Scripts\python.exe speech\worker.py

For a normal installation, run `pnpm run setup:voice-local` from the repository
root before starting DSH. The setup command is idempotent and may be rerun after
upgrading dependencies or deleting the cache.
