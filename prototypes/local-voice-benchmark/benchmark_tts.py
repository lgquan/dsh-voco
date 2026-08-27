"""THROWAWAY PROTOTYPE: benchmark CosyVoice 3 streaming inference on CPU."""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import psutil
import soundfile as sf


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent
COSYVOICE_ROOT = ROOT / "vendor" / "CosyVoice"
MODEL_ID = os.environ.get("DSH_TTS_MODEL_ID", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512")
MODEL_NAME = os.environ.get("DSH_TTS_MODEL_NAME", "Fun-CosyVoice3-0.5B-2512")
MODEL_DIR = ROOT / "models" / MODEL_NAME
RESULTS_DIR = ROOT / "results"
OUTPUT_WAV = ROOT / "audio" / f"{MODEL_NAME.lower()}-cpu.wav"
TEXT = "我已经检查完了，主要问题是登录状态没有正确恢复。要我直接修改吗？"
PROMPT_TEXT = "You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。"
PROMPT_WAV = COSYVOICE_ROOT / "asset" / "zero_shot_prompt.wav"


def main() -> None:
    if not COSYVOICE_ROOT.exists():
        raise FileNotFoundError(f"CosyVoice checkout not found: {COSYVOICE_ROOT}")
    sys.path.insert(0, str(COSYVOICE_ROOT))
    sys.path.insert(0, str(COSYVOICE_ROOT / "third_party" / "Matcha-TTS"))

    import torch
    from modelscope import snapshot_download

    MODEL_DIR.parent.mkdir(parents=True, exist_ok=True)
    if not (MODEL_DIR / "cosyvoice3.yaml").exists():
        print(f"Downloading {MODEL_ID}…", flush=True)
        snapshot_download(
            MODEL_ID,
            local_dir=str(MODEL_DIR),
        )

    from cosyvoice.cli.cosyvoice import AutoModel

    process = psutil.Process(os.getpid())
    rss_before = process.memory_info().rss
    load_started = time.perf_counter()
    model_kwargs = {"model_dir": str(MODEL_DIR), "load_trt": False, "fp16": False}
    if "CosyVoice3" in MODEL_NAME or "CosyVoice2" in MODEL_NAME:
        model_kwargs["load_vllm"] = False
    model = AutoModel(**model_kwargs)
    model_load_seconds = time.perf_counter() - load_started
    rss_loaded = process.memory_info().rss

    print(f"Model loaded in {model_load_seconds:.3f}s; synthesizing on {torch.device('cpu')}…", flush=True)
    started = time.perf_counter()
    first_chunk_seconds: float | None = None
    chunks: list[np.ndarray] = []
    for output in model.inference_zero_shot(
        TEXT,
        PROMPT_TEXT,
        str(PROMPT_WAV),
        stream=True,
    ):
        elapsed = time.perf_counter() - started
        if first_chunk_seconds is None:
            first_chunk_seconds = elapsed
        audio = output["tts_speech"].detach().cpu().numpy().reshape(-1).astype(np.float32)
        chunks.append(audio)
        print(f"chunk={len(chunks)} elapsed={elapsed:.3f}s samples={len(audio)}", flush=True)

    total_seconds = time.perf_counter() - started
    if not chunks:
        raise RuntimeError("CosyVoice produced no audio chunks")
    combined = np.concatenate(chunks)
    audio_seconds = len(combined) / model.sample_rate
    OUTPUT_WAV.parent.mkdir(parents=True, exist_ok=True)
    sf.write(OUTPUT_WAV, combined, model.sample_rate, subtype="PCM_16")
    rss_done = process.memory_info().rss
    result = {
        "measured_at": datetime.now().astimezone().isoformat(),
        "text": TEXT,
        "model_id": MODEL_ID,
        "model_name": MODEL_NAME,
        "device": "cpu",
        "torch": torch.__version__,
        "sample_rate": model.sample_rate,
        "model_load_seconds": round(model_load_seconds, 3),
        "first_chunk_seconds": None if first_chunk_seconds is None else round(first_chunk_seconds, 3),
        "synthesis_seconds": round(total_seconds, 3),
        "audio_seconds": round(audio_seconds, 3),
        "realtime_factor": round(total_seconds / audio_seconds, 3),
        "chunk_count": len(chunks),
        "rss_before_gb": round(rss_before / 1024**3, 3),
        "rss_loaded_gb": round(rss_loaded / 1024**3, 3),
        "rss_done_gb": round(rss_done / 1024**3, 3),
        "output_wav": str(OUTPUT_WAV.resolve()),
    }
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    (RESULTS_DIR / "tts.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
