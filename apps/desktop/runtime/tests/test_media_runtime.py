from __future__ import annotations

import importlib.util
import pathlib
import tempfile
import types
import unittest
from unittest import mock


RUNTIME_PATH = pathlib.Path(__file__).resolve().parents[1] / "media_runtime.py"
SPEC = importlib.util.spec_from_file_location("material_media_runtime", RUNTIME_PATH)
assert SPEC is not None and SPEC.loader is not None
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


class _Image:
    size = (200, 100)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class _PaddleEngine:
    def __init__(self, **options):
        assert options["device"] == "cpu"
        assert options["text_detection_model_name"] == "PP-OCRv5_mobile_det"
        assert options["text_recognition_model_name"] == "PP-OCRv5_mobile_rec"
        assert options["use_doc_orientation_classify"] is False
        assert options["use_doc_unwarping"] is False
        assert options["use_textline_orientation"] is False

    def predict(self, _image_path):
        return [types.SimpleNamespace(json={
            "res": {
                "rec_polys": [[[20, 10], [120, 10], [120, 30], [20, 30]]],
                "rec_scores": [0.96],
                "rec_texts": ["新品上新"],
            }
        })]


class _WhisperModel:
    def __init__(self, _model_path, **options):
        assert options == {
            "compute_type": "int8",
            "cpu_threads": 4,
            "device": "cpu",
            "local_files_only": True,
            "num_workers": 1,
        }

    def transcribe(self, _source_path, **options):
        assert options["vad_filter"] is True
        assert options["word_timestamps"] is True
        assert options["beam_size"] == 3
        assert options["initial_prompt"] == "以下是普通话内容，请使用简体中文。"
        word = types.SimpleNamespace(word="看", start=0.1, end=0.3, probability=0.91)
        segment = types.SimpleNamespace(
            avg_logprob=-0.1,
            end=0.8,
            start=0.1,
            text="看这里",
            words=[word],
        )
        return iter([segment]), types.SimpleNamespace(language="zh")


class _Waveform(list):
    ndim = 1


class _Tensor:
    def __init__(self, value):
        self.value = value

    def numpy(self):
        return self.value


class _Yamnet:
    def __init__(self, class_map_path):
        self._class_map_path = class_map_path

    def __call__(self, _waveform):
        return _Tensor([[0.05, 0.9], [0.04, 0.8]]), None, None

    def class_map_path(self):
        return _Tensor(str(self._class_map_path).encode("utf-8"))


class _Numpy:
    @staticmethod
    def argmax(values):
        return max(range(len(values)), key=lambda index: values[index])

    @staticmethod
    def mean(values, axis=None):
        if axis == 1:
            return _Waveform([sum(value) / len(value) for value in values])
        return sum(values) / len(values)

    @staticmethod
    def square(values):
        return [value * value for value in values]

    @staticmethod
    def sqrt(value):
        return value ** 0.5


class MediaRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)
        self.ocr_model = self.root / "ocr"
        (self.ocr_model / "det").mkdir(parents=True)
        (self.ocr_model / "rec").mkdir()
        (self.ocr_model / "det" / "inference.json").write_text("{}")
        (self.ocr_model / "rec" / "inference.json").write_text("{}")
        self.asr_model = self.root / "asr"
        self.asr_model.mkdir()
        (self.asr_model / "config.json").write_text("{}")
        (self.asr_model / "model.bin").write_bytes(b"model")
        self.yamnet_model = self.root / "yamnet"
        (self.yamnet_model / "variables").mkdir(parents=True)
        (self.yamnet_model / "saved_model.pb").write_bytes(b"model")
        (self.yamnet_model / "variables" / "variables.index").write_bytes(b"index")
        self.class_map = self.yamnet_model / "class_map.csv"
        self.class_map.write_text("index,mid,display_name\n0,/m/speech,Speech\n1,/m/music,Music\n")
        self.source = self.root / "source.bin"
        self.source.write_bytes(b"source")

    def tearDown(self):
        self.temporary.cleanup()

    def _module(self, name):
        modules = {
            "PIL.Image": types.SimpleNamespace(open=lambda _path: _Image()),
            "faster_whisper": types.SimpleNamespace(
                WhisperModel=_WhisperModel,
                __version__="1.2.1",
            ),
            "numpy": _Numpy,
            "paddleocr": types.SimpleNamespace(PaddleOCR=_PaddleEngine, __version__="3.7.0"),
            "soundfile": types.SimpleNamespace(
                __version__="0.13.1",
                read=lambda _path, dtype: (_Waveform([0.1] * 20_000), 16_000),
            ),
            "tensorflow": types.SimpleNamespace(
                __version__="2.21.0",
                saved_model=types.SimpleNamespace(
                    load=lambda _path: _Yamnet(self.class_map),
                ),
            ),
        }
        return modules[name]

    def test_health_requires_complete_local_models(self):
        with mock.patch.object(runtime.importlib, "import_module", side_effect=self._module):
            for action, key, model in (
                ("ocr", "ocrModelPath", self.ocr_model),
                ("asr", "asrModelPath", self.asr_model),
                ("audio_event", "audioEventModelPath", self.yamnet_model),
            ):
                result = runtime._health(action, {key: str(model)})
                self.assertTrue(result["available"])
        (self.asr_model / "model.bin").unlink()
        result = runtime._health("asr", {"asrModelPath": str(self.asr_model)})
        self.assertFalse(result["available"])

    def test_ocr_uses_v3_local_model_contract(self):
        with mock.patch.object(runtime.importlib, "import_module", side_effect=self._module):
            result = runtime._run_ocr({
                "items": [{"path": str(self.source), "timeMs": 500}],
                "language": "ch",
                "modelPath": str(self.ocr_model),
            })
        self.assertEqual(result["segments"][0]["text"], "新品上新")
        self.assertEqual(result["segments"][0]["region"], {
            "height": 0.2,
            "width": 0.5,
            "x": 0.1,
            "y": 0.1,
        })
        self.assertNotIn(str(self.source), str(result))

    def test_asr_is_offline_cpu_int8_with_word_timestamps(self):
        with mock.patch.object(runtime.importlib, "import_module", side_effect=self._module):
            result = runtime._run_asr({
                "modelPath": str(self.asr_model),
                "sourcePath": str(self.source),
                "language": "zh",
                "wordTimestamps": True,
            })
        self.assertEqual(result["detectedLanguage"], "zh")
        self.assertEqual(result["segments"][0]["words"][0]["startMs"], 100)
        self.assertNotIn(str(self.source), str(result))

    def test_audio_event_uses_local_saved_model_and_reports_timing_limits(self):
        with mock.patch.object(runtime.importlib, "import_module", side_effect=self._module):
            result = runtime._run_audio_event({
                "audioPath": str(self.source),
                "modelPath": str(self.yamnet_model),
                "threshold": 0.25,
            })
        self.assertEqual(result["events"][0]["eventType"], "music")
        self.assertEqual(result["events"][0]["startMs"], 0)
        self.assertIn("0.48 秒步长", result["limitations"][0])
        self.assertNotIn(str(self.source), str(result))


if __name__ == "__main__":
    unittest.main()
