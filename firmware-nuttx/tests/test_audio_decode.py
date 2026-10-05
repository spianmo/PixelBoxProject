#!/usr/bin/env python3
"""宿主编译真实解码器，验证 WAV 边界及 ffmpeg 生成的真实 MP3。"""
from pathlib import Path
import ctypes
import errno
import math
import os
import shutil
import struct
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]


def wav(samples, rate=16000, channels=1, bits=16, extra=b""):
    raw = bytes(samples) if bits == 8 else struct.pack("<" + "h" * len(samples), *samples)
    alignment = channels * bits // 8
    fmt = struct.pack("<HHIIHH", 1, channels, rate, rate * alignment, alignment, bits)
    body = b"WAVEfmt " + struct.pack("<I", len(fmt)) + fmt + extra
    body += b"data" + struct.pack("<I", len(raw)) + raw + (b"\0" if len(raw) & 1 else b"")
    return b"RIFF" + struct.pack("<I", len(body)) + body


class AudioDecodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="pixelbox-audio-decode-")
        cls.path = Path(cls.directory.name)
        target = cls.path / "decode.so"
        result = subprocess.run([os.environ.get("CC", "cc"), "-std=c11", "-O2", "-g",
                                 "-Wall", "-Wextra", "-Werror", "-shared", "-fPIC",
                                 f"-I{PROJECT / 'include'}", str(PROJECT / "src/audio_decode.c"),
                                 "-lm", "-o", str(target)], capture_output=True, text=True, timeout=20)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        cls.lib = ctypes.CDLL(str(target))
        cls.lib.px_audio_decoder_open.argtypes = [ctypes.c_void_p, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_uint)]
        cls.lib.px_audio_decoder_read.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_size_t, ctypes.POINTER(ctypes.c_bool)]
        cls.lib.px_audio_decoder_read.restype = ctypes.c_ssize_t
        cls.lib.px_audio_decoder_close.argtypes = [ctypes.c_void_p]

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def decode(self, source, frames=257):
        data = ctypes.create_string_buffer(source)
        decoder = ctypes.c_void_p()
        rate, channels = ctypes.c_uint(), ctypes.c_uint()
        result = self.lib.px_audio_decoder_open(data, len(source), ctypes.byref(decoder),
                                               ctypes.byref(rate), ctypes.byref(channels))
        if result:
            return result, None, None, b"", []
        output = ctypes.create_string_buffer(frames * 4)
        finished = ctypes.c_bool(False)
        pcm, chunks = bytearray(), []
        try:
            for _ in range(10000):
                result = self.lib.px_audio_decoder_read(decoder, output, frames, ctypes.byref(finished))
                if result < 0:
                    return result, rate.value, channels.value, bytes(pcm), chunks
                pcm.extend(output.raw[:result * 4])
                chunks.append((result, finished.value))
                if finished.value:
                    break
            else:
                self.fail("decoder did not finish")
        finally:
            self.lib.px_audio_decoder_close(decoder)
        return 0, rate.value, channels.value, bytes(pcm), chunks

    def test_wav_pcm16_mono_and_exact_final(self):
        samples = [-32768, -123, 0, 123, 32767]
        error, rate, channels, pcm, chunks = self.decode(wav(samples), frames=5)
        self.assertEqual((error, rate, channels), (0, 16000, 1))
        self.assertEqual(struct.unpack("<10h", pcm), tuple(x for sample in samples for x in [sample, sample]))
        self.assertEqual(chunks, [(5, True)])

    def test_wav_pcm8_stereo_and_odd_chunks(self):
        extra = b"JUNK" + struct.pack("<I", 3) + b"abc\0"
        error, rate, channels, pcm, _ = self.decode(wav([0, 255, 128, 127], 22050, 2, 8, extra), 1)
        self.assertEqual((error, rate, channels), (0, 22050, 2))
        self.assertEqual(struct.unpack("<4h", pcm), (-32768, 32512, 0, -256))

    def test_wav_rejects_truncation_bad_alignment_and_missing_format(self):
        good = wav([1, 2, 3])
        for length in [1, 8, 11, 12, 20, 35, len(good) - 1]:
            self.assertLess(self.decode(good[:length])[0], 0)
        bad = bytearray(good)
        bad[32:34] = b"\1\0"
        self.assertEqual(self.decode(bytes(bad))[0], -errno.EBADMSG)
        bad = bytearray(good)
        bad[12:16] = b"LIST"
        self.assertEqual(self.decode(bytes(bad))[0], -errno.EBADMSG)

    def test_wav_rejects_unsupported_format_and_rate(self):
        bad = bytearray(wav([1, 2]))
        bad[20:22] = b"\3\0"
        self.assertEqual(self.decode(bytes(bad))[0], -errno.ENOTSUP)
        self.assertEqual(self.decode(wav([1, 2], rate=12345))[0], -errno.ENOTSUP)

    def mp3(self, rate=44100, channels=1):
        executable = shutil.which("ffmpeg")
        if not executable:
            self.skipTest("ffmpeg is required for real MP3 regression")
        destination = self.path / f"{rate}-{channels}.mp3"
        if not destination.exists():
            expression = "sin(2*PI*440*t)" if channels == 1 else "sin(2*PI*440*t)|sin(2*PI*880*t)"
            command = [executable, "-v", "error", "-f", "lavfi", "-i",
                       f"aevalsrc={expression}:s={rate}:d=0.3", "-codec:a", "libmp3lame",
                       "-b:a", "64k", "-y", str(destination)]
            subprocess.run(command, check=True, capture_output=True, timeout=8)
        return destination.read_bytes()

    @staticmethod
    def frequency(samples, rate):
        samples = samples[len(samples) // 3:len(samples) * 2 // 3]
        crossings = sum(a <= 0 < b for a, b in zip(samples, samples[1:]))
        return crossings * rate / len(samples)

    def test_real_mp3_mono_sample_rate_and_waveform(self):
        for rate in [11025, 16000, 44100]:
            error, actual_rate, channels, pcm, chunks = self.decode(self.mp3(rate))
            self.assertEqual((error, actual_rate, channels), (0, rate, 1))
            samples = struct.unpack("<" + "h" * (len(pcm) // 2), pcm)
            self.assertEqual(samples[::2], samples[1::2])
            self.assertAlmostEqual(self.frequency(samples[::2], rate), 440, delta=20)
            self.assertGreater(len(pcm) // 4, rate // 4)
            self.assertTrue(chunks[-1][1])

    def test_real_mp3_stereo_preserves_channels(self):
        error, rate, channels, pcm, _ = self.decode(self.mp3(channels=2), frames=1152)
        self.assertEqual((error, rate, channels), (0, 44100, 2))
        samples = struct.unpack("<" + "h" * (len(pcm) // 2), pcm)
        self.assertAlmostEqual(self.frequency(samples[::2], rate), 440, delta=20)
        self.assertAlmostEqual(self.frequency(samples[1::2], rate), 880, delta=20)

    def test_mp3_id3v1_tail_and_truncated_frame(self):
        encoded = self.mp3()
        good = self.decode(encoded)
        tagged = self.decode(encoded + b"TAG" + b"\0" * 125)
        self.assertEqual(tagged[:4], good[:4])
        self.assertEqual(self.decode(encoded[:-100])[0], -errno.EBADMSG)

    def test_invalid_id3_syncsafe_and_random_data(self):
        self.assertEqual(self.decode(b"ID3\4\0\0\x80\0\0\0")[0], -errno.EBADMSG)
        self.assertEqual(self.decode(b"ID3\4\0\0\0\0\1\0")[0], -errno.EBADMSG)
        self.assertEqual(self.decode(b"invalid audio bytes" * 100)[0], -errno.EBADMSG)

    def test_mp3_rejects_midstream_format_switch(self):
        first, second = self.mp3(16000), self.mp3(44100)
        # 仅去掉第二段 ID3 元数据，保留真实 MPEG 帧格式切换。
        if second.startswith(b"ID3"):
            size = sum(second[6 + index] << (7 * (3 - index)) for index in range(4))
            second = second[size + 10:]
        self.assertIn(self.decode(first + second)[0], [-errno.ENOTSUP, -errno.EBADMSG])


if __name__ == "__main__":
    unittest.main()
