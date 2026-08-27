# dsh-voco local ONNX models

`setup-local-voice.mjs` is the cross-platform installation adapter for local
speech models. It runs automatically from `pnpm install` and can also be run
manually:

```sh
pnpm run setup:voice-local
```

Assets are stored in `speech/models` and are intentionally excluded from Git:

- `vad/silero_vad.onnx`
- `asr/paraformer`: bilingual Chinese/English streaming Paraformer
- Edge TTS is used for speech output with the `zh-CN-XiaoxiaoNeural` voice.

The installer downloads to `.part` files and renames them only after a complete
transfer. Existing non-empty files are reused. Application startup never
downloads models.

Runtime code is in `packages/voice-local`. It uses `sherpa-onnx-node`,
while Edge TTS provides the online speech output; Python, pip, Torch, and virtual
environments are not part of the runtime or installation flow.
