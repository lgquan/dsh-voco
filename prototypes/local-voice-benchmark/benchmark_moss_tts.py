"""THROWAWAY PROTOTYPE: benchmark MOSS-TTS-Nano ONNX streaming on CPU."""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import psutil


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
MOSS_ROOT = ROOT / "vendor" / "MOSS-TTS-Nano"
MODEL_DIR = MOSS_ROOT / "models"
OUTPUT_WAV = ROOT / "audio" / "moss-tts-nano-onnx-cpu.wav"
RESULT_JSON = ROOT / "results" / "moss-tts-nano.json"
TEXT = "我已经检查完了，主要问题是登录状态没有正确恢复。要我直接修改吗？"


def main() -> None:
    sys.path.insert(0, str(MOSS_ROOT))
    from onnx_tts_runtime import OnnxTtsRuntime

    process = psutil.Process(os.getpid())
    rss_before = process.memory_info().rss
    load_started = time.perf_counter()
    runtime = OnnxTtsRuntime(model_dir=MODEL_DIR, thread_count=4, execution_provider="cpu")
    model_load_seconds = time.perf_counter() - load_started
    rss_loaded = process.memory_info().rss

    OUTPUT_WAV.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    result = runtime.synthesize(
        text=TEXT,
        voice="Junhao",
        output_audio_path=OUTPUT_WAV,
        sample_mode="fixed",
        streaming=True,
        enable_wetext=False,
        enable_normalize_tts_text=True,
        seed=42,
    )
    synthesis_seconds = time.perf_counter() - started
    waveform = result["waveform"]
    audio_seconds = len(waveform) / int(result["sample_rate"])
    first_audio_seconds = result["chunk_results"][0].get("first_audio_seconds")
    output = {
        "measured_at": datetime.now().astimezone().isoformat(),
        "text": TEXT,
        "model": "OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX",
        "codec": "OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX",
        "device": "cpu",
        "cpu_threads": 4,
        "sample_rate": int(result["sample_rate"]),
        "model_load_seconds": round(model_load_seconds, 3),
        "first_audio_seconds": None if first_audio_seconds is None else round(first_audio_seconds, 3),
        "synthesis_seconds": round(synthesis_seconds, 3),
        "audio_seconds": round(audio_seconds, 3),
        "realtime_factor": round(synthesis_seconds / audio_seconds, 3),
        "rss_before_gb": round(rss_before / 1024**3, 3),
        "rss_loaded_gb": round(rss_loaded / 1024**3, 3),
        "rss_done_gb": round(process.memory_info().rss / 1024**3, 3),
        "output_wav": str(OUTPUT_WAV.resolve()),
    }
    RESULT_JSON.parent.mkdir(parents=True, exist_ok=True)
    RESULT_JSON.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
