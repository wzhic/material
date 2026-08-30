#!/usr/bin/env python3
"""Bundled local OCR/ASR/audio-event runner. JSON only; never logs media data."""

from __future__ import annotations

import csv
import importlib
import json
import math
import pathlib
import sys
from typing import Any, Dict, Iterable, List


def _module_version(module: Any) -> str:
    return str(getattr(module, "__version__", "unknown"))[:120]


def _required_model(payload: Dict[str, Any], key: str) -> pathlib.Path:
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise ValueError("local model path is not configured")
    return pathlib.Path(value).resolve(strict=True)


def _directory_has_file(directory: pathlib.Path) -> bool:
    return directory.is_dir() and any(item.is_file() for item in directory.rglob("*"))


def _validate_model_layout(action: str, model_path: pathlib.Path) -> None:
    if action == "ocr":
        if not all(_directory_has_file(model_path / name) for name in ("det", "rec")):
            raise ValueError("OCR model directory requires populated det and rec children")
    elif action == "asr":
        if not all((model_path / name).is_file() for name in ("config.json", "model.bin")):
            raise ValueError("ASR model directory is incomplete")
    elif action == "audio_event":
        if not (model_path / "saved_model.pb").is_file() or not _directory_has_file(
            model_path / "variables"
        ):
            raise ValueError("audio event model directory is incomplete")


def _health(action: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    modules = {
        "ocr": ("paddleocr", "PIL.Image"),
        "asr": ("faster_whisper",),
        "audio_event": ("numpy", "soundfile", "tensorflow"),
    }
    if action not in modules:
        return {"available": False, "detail": "unknown capability", "runtimeVersion": None}
    versions: List[str] = []
    try:
        model_keys = {
            "ocr": "ocrModelPath",
            "asr": "asrModelPath",
            "audio_event": "audioEventModelPath",
        }
        model_path = _required_model(payload, model_keys[action])
        _validate_model_layout(action, model_path)
        for name in modules[action]:
            module = importlib.import_module(name)
            versions.append(f"{name}/{_module_version(module)}")
    except Exception:
        return {
            "available": False,
            "detail": f"required local modules or models for {action} are not ready",
            "runtimeVersion": None,
        }
    return {
        "available": True,
        "detail": "local runtime is ready",
        "runtimeVersion": ",".join(versions)[:120],
    }


def _box_region(points: Iterable[Iterable[Any]], width: int, height: int) -> Dict[str, float]:
    pairs = [(float(point[0]), float(point[1])) for point in points]
    xs = [point[0] for point in pairs]
    ys = [point[1] for point in pairs]
    x0, x1 = max(0.0, min(xs)), min(float(width), max(xs))
    y0, y1 = max(0.0, min(ys)), min(float(height), max(ys))
    return {
        "x": x0 / width,
        "y": y0 / height,
        "width": max(0.0, x1 - x0) / width,
        "height": max(0.0, y1 - y0) / height,
    }


def _flatten_ocr_v2(value: Any) -> Iterable[Any]:
    if not isinstance(value, list):
        return []
    if value and isinstance(value[0], list) and len(value[0]) == 2:
        return value
    flattened: List[Any] = []
    for child in value:
        flattened.extend(_flatten_ocr_v2(child))
    return flattened


def _ocr_v3_mapping(value: Any) -> Dict[str, Any] | None:
    candidate = value
    if not isinstance(candidate, dict):
        candidate = getattr(value, "json", None)
        if callable(candidate):
            candidate = candidate()
    if not isinstance(candidate, dict):
        return None
    result = candidate.get("res", candidate)
    return result if isinstance(result, dict) else None


def _ocr_v3_lines(value: Any) -> Iterable[Any]:
    mapping = _ocr_v3_mapping(value)
    if mapping is None:
        return []
    texts = mapping.get("rec_texts")
    scores = mapping.get("rec_scores")
    polygons = mapping.get("rec_polys")
    if polygons is None:
        polygons = mapping.get("dt_polys")
    if not all(hasattr(item, "__iter__") for item in (texts, scores, polygons)):
        return []
    return zip(polygons, zip(texts, scores))


def _run_ocr(payload: Dict[str, Any]) -> Dict[str, Any]:
    paddleocr = importlib.import_module("paddleocr")
    pillow = importlib.import_module("PIL.Image")
    language = str(payload.get("language") or "ch")[:32]
    model_path = _required_model(payload, "modelPath")
    detection_model = model_path / "det"
    recognition_model = model_path / "rec"
    if not detection_model.is_dir() or not recognition_model.is_dir():
        raise ValueError("OCR model directory requires det and rec children")
    engine = paddleocr.PaddleOCR(
        text_detection_model_name="PP-OCRv5_mobile_det",
        text_detection_model_dir=str(detection_model),
        text_recognition_model_name="PP-OCRv5_mobile_rec",
        text_recognition_model_dir=str(recognition_model),
        use_doc_orientation_classify=False,
        use_doc_unwarping=False,
        use_textline_orientation=False,
        device="cpu",
        lang=language,
    )
    segments: List[Dict[str, Any]] = []
    for item in payload.get("items") or []:
        image_path = pathlib.Path(str(item.get("path") or "")).resolve(strict=True)
        with pillow.open(image_path) as image:
            width, height = image.size
        result = engine.predict(str(image_path))
        lines: List[Any] = []
        for prediction in result:
            lines.extend(_ocr_v3_lines(prediction))
        for line in lines:
            try:
                points, text_score = line
                text, score = text_score
                region = _box_region(points, int(width), int(height))
                if not str(text).strip() or region["width"] <= 0 or region["height"] <= 0:
                    continue
                time_ms = item.get("timeMs")
                segments.append({
                    "text": str(text).strip(),
                    "confidence": max(0.0, min(1.0, float(score))),
                    "region": region,
                    "startMs": None if time_ms is None else int(time_ms),
                    "endMs": None if time_ms is None else int(time_ms),
                })
            except (TypeError, ValueError, IndexError):
                continue
    return {
        "language": language,
        "runtimeVersion": f"paddleocr/{_module_version(paddleocr)}",
        "segments": segments,
    }


def _probability(log_probability: Any) -> float:
    try:
        return max(0.0, min(1.0, math.exp(float(log_probability))))
    except (TypeError, ValueError, OverflowError):
        return 0.0


def _run_asr(payload: Dict[str, Any]) -> Dict[str, Any]:
    faster_whisper = importlib.import_module("faster_whisper")
    model_path = pathlib.Path(str(payload.get("modelPath") or "")).resolve(strict=True)
    source_path = pathlib.Path(str(payload.get("sourcePath") or "")).resolve(strict=True)
    _validate_model_layout("asr", model_path)
    model = faster_whisper.WhisperModel(
        str(model_path),
        device="cpu",
        compute_type="int8",
        cpu_threads=4,
        num_workers=1,
        local_files_only=True,
    )
    language = payload.get("language") or None
    initial_prompt = (
        "以下是普通话内容，请使用简体中文。"
        if isinstance(language, str) and language.lower().replace("_", "-").startswith("zh")
        else None
    )
    segments_iter, info = model.transcribe(
        str(source_path),
        beam_size=3,
        condition_on_previous_text=False,
        initial_prompt=initial_prompt,
        language=language,
        vad_filter=True,
        word_timestamps=bool(payload.get("wordTimestamps", True)),
    )
    segments: List[Dict[str, Any]] = []
    for segment in segments_iter:
        words = []
        for word in getattr(segment, "words", None) or []:
            words.append({
                "text": str(getattr(word, "word", "")).strip(),
                "startMs": round(float(getattr(word, "start", 0.0)) * 1000),
                "endMs": round(float(getattr(word, "end", 0.0)) * 1000),
                "confidence": float(getattr(word, "probability", 0.0)),
            })
        segments.append({
            "text": str(getattr(segment, "text", "")).strip(),
            "startMs": round(float(getattr(segment, "start", 0.0)) * 1000),
            "endMs": round(float(getattr(segment, "end", 0.0)) * 1000),
            "confidence": _probability(getattr(segment, "avg_logprob", None)),
            "speaker": None,
            "words": words,
        })
    return {
        "detectedLanguage": str(getattr(info, "language", "")) or None,
        "runtimeVersion": f"faster-whisper/{_module_version(faster_whisper)}",
        "segments": segments,
    }


def _event_type(label: str) -> str:
    lowered = label.lower()
    if any(word in lowered for word in ("speech", "voice", "conversation", "narration")):
        return "speech"
    if any(word in lowered for word in ("music", "song", "instrument", "singing")):
        return "music"
    if label:
        return "effect"
    return "other"


def _merge_events(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    for event in events:
        previous = merged[-1] if merged else None
        if (
            previous
            and previous["label"] == event["label"]
            and previous["eventType"] == event["eventType"]
            and event["startMs"] <= previous["endMs"] + 100
        ):
            previous["endMs"] = max(previous["endMs"], event["endMs"])
            previous["confidence"] = max(previous["confidence"], event["confidence"])
        else:
            merged.append(dict(event))
    return merged


def _rhythm_change_events(waveform: Any, sample_rate: int, numpy: Any) -> List[Dict[str, Any]]:
    """Return bounded energy-change candidates; this is not a BPM estimator."""
    window = max(1, round(sample_rate * 0.48))
    hop = max(1, round(sample_rate * 0.24))
    energies: List[float] = []
    positions: List[int] = []
    for start in range(0, max(1, len(waveform) - window + 1), hop):
        values = waveform[start:start + window]
        if len(values) == 0:
            continue
        rms = float(numpy.sqrt(numpy.mean(numpy.square(values))))
        energies.append(20.0 * math.log10(max(rms, 1e-8)))
        positions.append(start)
    events: List[Dict[str, Any]] = []
    for index in range(1, len(energies)):
        delta = abs(energies[index] - energies[index - 1])
        if delta < 6.0:
            continue
        center_ms = round(positions[index] * 1000 / sample_rate)
        events.append({
            "label": "Rhythm or energy change",
            "eventType": "other",
            "confidence": min(1.0, delta / 18.0),
            "startMs": max(0, center_ms - 120),
            "endMs": center_ms + 120,
        })
    return events


def _run_audio_event(payload: Dict[str, Any]) -> Dict[str, Any]:
    numpy = importlib.import_module("numpy")
    soundfile = importlib.import_module("soundfile")
    tensorflow = importlib.import_module("tensorflow")
    model_path = pathlib.Path(str(payload.get("modelPath") or "")).resolve(strict=True)
    _validate_model_layout("audio_event", model_path)
    audio_path = pathlib.Path(str(payload.get("audioPath") or "")).resolve(strict=True)
    waveform, sample_rate = soundfile.read(str(audio_path), dtype="float32")
    if int(sample_rate) != 16000:
        raise ValueError("audio event input must be 16 kHz")
    if getattr(waveform, "ndim", 1) > 1:
        waveform = numpy.mean(waveform, axis=1)
    model = tensorflow.saved_model.load(str(model_path))
    scores, _embeddings, _spectrogram = model(waveform)
    class_map_path = model.class_map_path().numpy().decode("utf-8")
    with open(class_map_path, "r", encoding="utf-8") as handle:
        labels = [row["display_name"] for row in csv.DictReader(handle)]
    score_values = scores.numpy()
    threshold = max(0.05, min(1.0, float(payload.get("threshold") or 0.25)))
    events: List[Dict[str, Any]] = []
    for index, row in enumerate(score_values):
        class_index = int(numpy.argmax(row))
        score = float(row[class_index])
        if score < threshold:
            continue
        label = labels[class_index]
        events.append({
            "label": label,
            "eventType": _event_type(label),
            "confidence": score,
            "startMs": round(index * 480),
            "endMs": round(index * 480 + 960),
        })
    events.extend(_rhythm_change_events(waveform, int(sample_rate), numpy))
    events.sort(key=lambda event: (event["startMs"], event["label"]))
    return {
        "events": _merge_events(events),
        "limitations": [
            "YAMNet 采用约 0.96 秒窗口、0.48 秒步长，事件边界为近似值",
            "节奏变化是本地能量差候选，不等同于 BPM 或节拍真值",
        ],
        "modelVersion": model_path.name,
        "runtimeVersion": f"tensorflow/{_module_version(tensorflow)},yamnet/local",
    }


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in ("--health", "--run"):
        return 2
    mode, action = sys.argv[1], sys.argv[2]
    if mode == "--health":
        try:
            payload = json.load(sys.stdin)
            if not isinstance(payload, dict):
                raise ValueError("health payload must be an object")
        except Exception:
            payload = {}
        print(json.dumps(_health(action, payload), ensure_ascii=False, separators=(",", ":")))
        return 0
    try:
        payload = json.load(sys.stdin)
        handlers = {"ocr": _run_ocr, "asr": _run_asr, "audio_event": _run_audio_event}
        output = handlers[action](payload)
        print(json.dumps(output, ensure_ascii=False, separators=(",", ":")))
        return 0
    except Exception:
        print(json.dumps({"error": "local capability failed"}, separators=(",", ":")))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
