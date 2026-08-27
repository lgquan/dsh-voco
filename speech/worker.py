"""Long-lived local speech worker used by dsh-voice-local."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import numpy as np

SAMPLE_RATE = 16_000
ASR_CHUNK_SAMPLES = 9_600
VAD_FRAME_SAMPLES = 512
END_SILENCE_SAMPLES = int(SAMPLE_RATE * 0.6)


class SpeechWorker:
    def __init__(self, model_dir: str | None, tts_root: str | None) -> None:
        repo_root = Path(__file__).resolve().parents[1]
        self.model_dir = self.resolve_path(model_dir, repo_root) if model_dir else None
        self.tts_root = self.resolve_path(tts_root, repo_root) if tts_root else None
        self.emit_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.tts_stop = threading.Event()
        self.audio_buffer = np.zeros((0,), dtype=np.float32)
        self.utterance_audio = np.zeros((0,), dtype=np.float32)
        self.asr_cache: dict[str, Any] = {}
        self.asr_text = ""
        self.utterance_id = ""
        self.speech_active = False
        self.silence_samples = 0
        self.vad_model: Any = None
        self.asr_model: Any = None
        self.tts_runtime: Any = None

    @staticmethod
    def resolve_path(value: str, base: Path) -> Path:
        path = Path(value).expanduser()
        return (path if path.is_absolute() else base / path).resolve()

    def emit(self, message: dict[str, object]) -> None:
        with self.emit_lock:
            sys.stdout.write(json.dumps(message, ensure_ascii=False) + "\n")
            sys.stdout.flush()

    def load_models(self) -> None:
        from silero_vad import load_silero_vad
        from funasr import AutoModel

        self.vad_model = load_silero_vad(onnx=True)
        self.asr_model = AutoModel(model="paraformer-zh-streaming", device="cpu", disable_update=True, disable_pbar=True)
        moss_root = self.tts_root or (Path(__file__).resolve().parent / "moss_tts_runtime")
        if not (moss_root / "onnx_tts_runtime.py").is_file():
            raise FileNotFoundError(
                "MOSS runtime not found under " + str(moss_root) + "; expected onnx_tts_runtime.py"
            )
        sys.path.insert(0, str(moss_root))
        from onnx_tts_runtime import OnnxTtsRuntime

        self.tts_runtime = OnnxTtsRuntime(model_dir=self.model_dir or (moss_root / "models"), thread_count=4, execution_provider="cpu")

    def handle_audio(self, encoded: str) -> None:
        raw = base64.b64decode(encoded, validate=True)
        if len(raw) % 2:
            raise ValueError("audio frame must contain an even number of PCM16 bytes")
        samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
        self.audio_buffer = np.concatenate((self.audio_buffer, samples))
        while len(self.audio_buffer) >= VAD_FRAME_SAMPLES:
            frame = self.audio_buffer[:VAD_FRAME_SAMPLES]
            self.audio_buffer = self.audio_buffer[VAD_FRAME_SAMPLES:]
            self.handle_frame(frame)

    def handle_frame(self, frame: np.ndarray) -> None:
        import torch

        probability = float(self.vad_model(torch.from_numpy(frame), SAMPLE_RATE).item())
        voiced = probability >= 0.5
        if voiced and not self.speech_active:
            self.speech_active = True
            self.silence_samples = 0
            self.utterance_id = str(uuid.uuid4())
            self.asr_cache = {}
            self.asr_text = ""
            self.utterance_audio = np.zeros((0,), dtype=np.float32)
            self.emit({"type": "transcription.started", "utteranceId": self.utterance_id})
        if not self.speech_active:
            return
        self.utterance_audio = np.concatenate((self.utterance_audio, frame))
        self.silence_samples = 0 if voiced else self.silence_samples + len(frame)
        while len(self.utterance_audio) >= ASR_CHUNK_SAMPLES:
            chunk = self.utterance_audio[:ASR_CHUNK_SAMPLES]
            self.utterance_audio = self.utterance_audio[ASR_CHUNK_SAMPLES:]
            self.feed_asr(chunk, is_final=False)
        if self.silence_samples >= END_SILENCE_SAMPLES:
            self.finish_utterance()

    def feed_asr(self, chunk: np.ndarray, is_final: bool) -> None:
        response = self.asr_model.generate(
            input=chunk,
            cache=self.asr_cache,
            is_final=is_final,
            chunk_size=[0, 10, 5],
            encoder_chunk_look_back=4,
            decoder_chunk_look_back=1,
        )
        text = "" if not response else str(response[0].get("text", ""))
        if text:
            self.asr_text += text
            self.emit({"type": "transcription.updated", "utteranceId": self.utterance_id, "text": self.asr_text})

    def finish_utterance(self) -> None:
        if not self.speech_active:
            return
        if len(self.utterance_audio) > 0:
            self.feed_asr(self.utterance_audio, is_final=True)
        self.emit({"type": "transcription.completed", "utteranceId": self.utterance_id, "text": self.asr_text.strip()})
        self.speech_active = False
        self.silence_samples = 0
        self.utterance_audio = np.zeros((0,), dtype=np.float32)

    def synthesize(self, response_id: str, text: str) -> None:
        self.tts_stop.clear()
        threading.Thread(target=self._synthesize, args=(response_id, text), daemon=True).start()

    def _synthesize(self, response_id: str, text: str) -> None:
        self.emit({"type": "tts.started", "responseId": response_id})
        try:
            def on_audio_chunk(waveform: np.ndarray) -> None:
                if self.tts_stop.is_set():
                    raise InterruptedError("local TTS interrupted")
                audio = np.asarray(waveform, dtype=np.float32)
                if audio.ndim > 1:
                    audio = audio.mean(axis=1)
                pcm = np.clip(audio, -1.0, 1.0)
                encoded = base64.b64encode((pcm * 32767).astype("<i2").tobytes()).decode("ascii")
                self.emit({"type": "tts.delta", "responseId": response_id, "audio": encoded})

            self.tts_runtime.synthesize(text=text, voice="Junhao", output_audio_path=None, sample_mode="fixed", streaming=True, enable_wetext=False, enable_normalize_tts_text=True, seed=42, on_audio_chunk=on_audio_chunk)
            if not self.tts_stop.is_set():
                self.emit({"type": "tts.done", "responseId": response_id})
        except InterruptedError:
            return
        except Exception as exc:
            self.emit({"type": "error", "message": "local TTS failed: " + str(exc)})

    def command(self, message: dict[str, object]) -> None:
        kind = message.get("type")
        if kind == "audio":
            self.handle_audio(str(message.get("audio", "")))
        elif kind == "commit":
            self.finish_utterance()
        elif kind == "synthesize":
            self.synthesize(str(message.get("responseId", "")), str(message.get("text", "")))
        elif kind == "interrupt":
            self.tts_stop.set()
        elif kind == "close":
            self.stop_event.set()
            self.tts_stop.set()
            self.emit({"type": "closed", "reason": "worker closed"})
        else:
            self.emit({"type": "error", "message": "unknown worker command: " + str(kind)})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir")
    parser.add_argument("--tts-root")
    args = parser.parse_args()
    cache_root = Path(__file__).resolve().parent / ".cache"
    cache_root.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("MODELSCOPE_CACHE", str(cache_root / "modelscope"))
    os.environ.setdefault("MODELSCOPE_HOME", str(cache_root / "modelscope"))
    os.environ.setdefault("TORCH_HOME", str(cache_root / "torch"))
    os.environ.setdefault("HF_HOME", str(cache_root / "huggingface"))
    worker = SpeechWorker(
        args.model_dir or os.environ.get("DSH_MOSS_MODEL_DIR"),
        args.tts_root or os.environ.get("DSH_MOSS_TTS_ROOT"),
    )
    try:
        started = time.perf_counter()
        worker.load_models()
        worker.emit({"type": "ready", "loadSeconds": round(time.perf_counter() - started, 3)})
        for line in sys.stdin:
            if worker.stop_event.is_set():
                break
            try:
                worker.command(json.loads(line))
            except Exception as exc:
                worker.emit({"type": "error", "message": str(exc)})
    except Exception as exc:
        worker.emit({"type": "error", "message": "local speech worker startup failed: " + str(exc)})
        raise


if __name__ == "__main__":
    main()
