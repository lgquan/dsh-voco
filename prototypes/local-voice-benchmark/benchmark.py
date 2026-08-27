"""THROWAWAY PROTOTYPE: benchmark local VAD and streaming ASR feasibility."""

from __future__ import annotations

import argparse
import json
import os
import platform
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np
import psutil
import soundfile as sf


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


ROOT = Path(__file__).resolve().parent
AUDIO_DIR = ROOT / "audio"
RESULTS_DIR = ROOT / "results"
DEFAULT_AUDIO = AUDIO_DIR / "microphone.wav"
SAMPLE_RATE = 16_000
TEST_SENTENCE = "请帮我检查这个 TypeScript 项目的 Agent、RAG、API、DeepSeek 和 MCP 配置。"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("system", "devices", "record", "vad", "asr", "all"))
    parser.add_argument("--input", type=Path, default=DEFAULT_AUDIO)
    parser.add_argument("--seconds", type=int, default=10)
    return parser.parse_args()


def system_info() -> dict[str, Any]:
    import torch

    xpu_available = bool(hasattr(torch, "xpu") and torch.xpu.is_available())
    info = {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "cpu": platform.processor(),
        "logical_cpu_count": psutil.cpu_count(),
        "ram_gb": round(psutil.virtual_memory().total / 1024**3, 1),
        "torch": torch.__version__,
        "cuda_available": torch.cuda.is_available(),
        "xpu_available": xpu_available,
        "torch_threads": torch.get_num_threads(),
    }
    print(json.dumps(info, ensure_ascii=False, indent=2))
    save_result("system", info)
    return info


def list_devices() -> None:
    import sounddevice as sd

    print(sd.query_devices())
    print(f"Default input/output: {sd.default.device}")


def record_microphone(seconds: int, output: Path) -> Path:
    import sounddevice as sd

    if seconds < 1:
        raise ValueError("seconds must be positive")
    output.parent.mkdir(parents=True, exist_ok=True)
    print("三秒后开始录音，请自然朗读：")
    print(TEST_SENTENCE)
    for remaining in (3, 2, 1):
        print(remaining, flush=True)
        time.sleep(1)
    print(f"录音中，共 {seconds} 秒……", flush=True)
    audio = sd.rec(seconds * SAMPLE_RATE, samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    sd.wait()
    sf.write(output, audio[:, 0], SAMPLE_RATE, subtype="PCM_16")
    print(f"录音完成：{output}")
    return output


def load_audio(path: Path) -> tuple[np.ndarray, float]:
    if not path.exists():
        raise FileNotFoundError(f"audio file not found: {path}")
    audio, sample_rate = sf.read(path, dtype="float32", always_2d=False)
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if sample_rate != SAMPLE_RATE:
        raise ValueError(f"expected {SAMPLE_RATE} Hz input, got {sample_rate} Hz")
    return np.asarray(audio, dtype=np.float32), len(audio) / SAMPLE_RATE


def benchmark_vad(path: Path) -> dict[str, Any]:
    import torch
    from silero_vad import get_speech_timestamps, load_silero_vad

    audio, duration = load_audio(path)
    started = time.perf_counter()
    model = load_silero_vad(onnx=True)
    load_seconds = time.perf_counter() - started
    waveform = torch.from_numpy(audio)
    get_speech_timestamps(waveform, model, sampling_rate=SAMPLE_RATE)
    timings: list[float] = []
    speech: list[dict[str, int]] = []
    for _ in range(5):
        started = time.perf_counter()
        speech = get_speech_timestamps(waveform, model, sampling_rate=SAMPLE_RATE)
        timings.append(time.perf_counter() - started)
    inference = min(timings)
    result = {
        "audio": str(path.resolve()),
        "audio_seconds": round(duration, 3),
        "model_load_seconds": round(load_seconds, 3),
        "best_inference_seconds": round(inference, 4),
        "realtime_factor": round(inference / duration, 5) if duration else None,
        "speech_segments_seconds": [
            {"start": round(item["start"] / SAMPLE_RATE, 3), "end": round(item["end"] / SAMPLE_RATE, 3)}
            for item in speech
        ],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    save_result("vad", result)
    return result


def benchmark_asr(path: Path) -> dict[str, Any]:
    from funasr import AutoModel

    audio, duration = load_audio(path)
    model_started = time.perf_counter()
    model = AutoModel(
        model="paraformer-zh-streaming",
        device="cpu",
        disable_update=True,
        disable_pbar=True,
    )
    model_load_seconds = time.perf_counter() - model_started

    chunk_size = [0, 10, 5]
    chunk_stride = chunk_size[1] * 960
    encoder_chunk_look_back = 4
    decoder_chunk_look_back = 1
    cache: dict[str, Any] = {}
    pieces: list[str] = []
    chunk_compute_seconds: list[float] = []
    first_partial_ready_seconds: float | None = None
    started = time.perf_counter()
    chunk_count = (len(audio) - 1) // chunk_stride + 1
    for index in range(chunk_count):
        speech_chunk = audio[index * chunk_stride : (index + 1) * chunk_stride]
        is_final = index == chunk_count - 1
        chunk_started = time.perf_counter()
        response = model.generate(
            input=speech_chunk,
            cache=cache,
            is_final=is_final,
            chunk_size=chunk_size,
            encoder_chunk_look_back=encoder_chunk_look_back,
            decoder_chunk_look_back=decoder_chunk_look_back,
        )
        compute_seconds = time.perf_counter() - chunk_started
        chunk_compute_seconds.append(compute_seconds)
        text = "" if not response else str(response[0].get("text", ""))
        if text:
            pieces.append(text)
            if first_partial_ready_seconds is None:
                audio_available = min((index + 1) * chunk_stride / SAMPLE_RATE, duration)
                first_partial_ready_seconds = audio_available + compute_seconds
            print(f"[{index + 1:02d}/{chunk_count:02d}] {text}")

    inference_seconds = time.perf_counter() - started
    transcript = "".join(pieces).strip()
    result = {
        "audio": str(path.resolve()),
        "audio_seconds": round(duration, 3),
        "model_load_seconds": round(model_load_seconds, 3),
        "inference_seconds": round(inference_seconds, 3),
        "realtime_factor": round(inference_seconds / duration, 4) if duration else None,
        "estimated_live_first_partial_seconds": (
            None if first_partial_ready_seconds is None else round(first_partial_ready_seconds, 3)
        ),
        "max_chunk_compute_seconds": round(max(chunk_compute_seconds, default=0.0), 3),
        "transcript": transcript,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    save_result("asr", result)
    return result


def save_result(name: str, result: dict[str, Any]) -> None:
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    payload = {"measured_at": datetime.now().astimezone().isoformat(), **result}
    (RESULTS_DIR / f"{name}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    args = parse_args()
    if args.action == "system":
        system_info()
    elif args.action == "devices":
        list_devices()
    elif args.action == "record":
        record_microphone(args.seconds, args.input)
    elif args.action == "vad":
        benchmark_vad(args.input)
    elif args.action == "asr":
        benchmark_asr(args.input)
    elif args.action == "all":
        system_info()
        benchmark_vad(args.input)
        benchmark_asr(args.input)


if __name__ == "__main__":
    main()
