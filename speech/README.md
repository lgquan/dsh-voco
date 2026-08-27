# dsh-live local ONNX models

`setup-local-voice.mjs` is the cross-platform installation adapter for local
speech models. It runs automatically from `pnpm install` and can also be run
manually:

```sh
pnpm run setup:voice-local
```

Assets are stored in `speech/models` and are intentionally excluded from Git:

- `vad/silero_vad.onnx`
- `asr/paraformer`: bilingual Chinese/English streaming Paraformer
- `tts/MOSS-TTS-Nano-100M-ONNX`
- `tts/MOSS-Audio-Tokenizer-Nano-ONNX`

The installer downloads to `.part` files and renames them only after a complete
transfer. Existing non-empty files are reused. Application startup never
downloads models.

Runtime code is in `packages/voice-local`. It uses `sherpa-onnx-node`,
`onnxruntime-node`, and a SentencePiece WASM tokenizer; Python, pip, Torch, and
virtual environments are not part of the runtime or installation flow.
