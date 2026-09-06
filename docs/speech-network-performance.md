# Speech and Network Diagnosis (2026-09-06)

Device: Waveshare ESP32-S3 AMOLED 2.16, 480x480, USB COM3,
`pixelbox-906ee8` at `192.168.31.100`; ESP-IDF 5.5, 8 MiB PSRAM.
The existing example7 application and configured Azure eastasia resource were
used. Subscription keys and account credentials are not included in logs.

## Confirmed Causes

- The original local VAD rejected desk-distance audio before Azure was called.
  A real device recording (128000 samples, RMS 187, peak 2156) was rejected by
  `px.speech.recognize`, but the same PCM sent to Azure returned `Success` and
  the complete expected sentence. The old onset floor was 0.012 RMS, with a
  noise estimator that could absorb quiet speech into its threshold.
- Every wake start rehashed the mapped model, created MultiNet7 and rebuilt
  the command table. Two consecutive device starts took 8454 and 8387 ms.
  Model initialization ran below the busy JS renderer's task priority.
- Wi-Fi used the default modem sleep mode, adding DTIM waits. TCP had only a
  5760-byte send buffer/window. Native speech uploaded WAV in 2048-byte writes
  and included silence preceding the utterance.
- Azure's caller-provided timeout was silently capped at 5000 ms per socket
  operation. Errors erased HTTP status and TLS details. Speech networking also
  ran below the JS renderer's priority on its core.

## Changes

- VAD onset is 0.004 RMS with adaptive noise and 0.0025 sustain hysteresis;
  180 ms of speech is still required. An impulse/noise regression and the
  real quiet recording both pass. Up to 200 ms pre-roll is preserved when
  trimming leading silence before upload.
- MultiNet weights and command table are reused between turns, cleaned before
  reuse, and released after 60 seconds idle or worker shutdown. Archive hashes
  are verified once per boot against the firmware's expected model hashes.
  Initialization and speech TLS run above JS rendering priority.
- Wi-Fi modem sleep is disabled by default (`PX_WIFI_POWER_SAVE` restores it).
  This increases idle power consumption. S3 speech TCP send/receive windows
  are 16384 bytes, receive mailbox 14, and uploads use 4096-byte writes.
- Request queues are bounded at 16 pending requests and skip obsolete VM work.
  WebSocket close/destroy jobs survive VM changes and request backpressure.
- Logs report queue wait, HTTP connection/upload/header/total times and Azure
  TLS/HTTP/recognition status without printing keys or response text. TLS
  connect allows up to 15 seconds; recognition headers use the remaining
  request budget.

## Validation

The fixed Chinese test sentence was synthesized on the computer, played over
its speaker, captured by the PixelBox microphone and recognized by Azure:
`今天天气很好，我们一起去公园散步。`

- Host Azure TTS: HTTP 200, 1337 ms, 116044-byte WAV.
- Host Azure STT of that WAV: HTTP 200, Success, 1544 ms.
- Host Azure STT of the device microphone recording: Success, 2118 ms.
- Fixed VAD on the actual recorded PCM detected speech and endpoint at 6080 ms.
- First device validation after VAD fix: native recognize returned the full
  sentence, including 6200 ms capture, 689 ms connection, 8110 ms upload and
  601 ms response headers. This prompted the subsequent upload changes.
- Wake start after cache/priority changes: 1731 ms cold and 129 ms cached,
  compared with 8454/8387 ms before. Native preparation logs were 1566/89 ms;
  Promise latency additionally includes JS scheduling.
- Native TTS successfully completed playback (6657 ms, including audio time).
- Final TCP/upload build: microphone recognize succeeded again in 11331 ms,
  including the configured 8000 ms capture. Upload after trimming was 183404
  bytes in 2313 ms, connection 661 ms, response headers 217 ms. The reduced
  upload time reflects both transport changes and fewer silence bytes.
- Fixed 116044-byte WAV device round trip: original 7230 ms; final warm
  request 4092 ms. The first request after flashing still took 6962 ms, with
  connection variability. Final warm HTTP log: connect 784 ms, upload 1522 ms,
  headers 1502 ms; LAN fixture download adds about 161 ms. This is not a
  guarantee that all network requests are uniformly faster.
- After restarting example7, repeated wake starts were 1502 and 177 ms.
- During subsequent interactive use, the existing app logged five successful
  login-chain HTTP requests taking 746, 632, 732, 667 and 579 ms. Later speech
  uploads of 56-73 KB took 716-999 ms, with Azure HTTP 200 responses in
  205-213 ms and cached wake preparation about 159-199 ms. No credentials or
  private transcript content were needed to inspect these timing logs.
- The 60-second idle-release probe was inconclusive because the user resumed
  speech while it ran. Active wake detection correctly retains the model.
  Model release on worker shutdown was observed in the device logs. The
  final application was left running without another disruptive restart.

## Reproduction

Build SDK first: `pnpm --filter @pixelbox/sdk run build`.
Run one device probe at a time; probes use shared diagnostic state and cancel
existing speech operations. They load the existing project speech config.

```sh
node tools/diagnose-speech.mjs status
node tools/diagnose-speech.mjs azure-host
node tools/diagnose-speech.mjs azure-device
node tools/diagnose-speech.mjs wake
node tools/diagnose-speech.mjs recognize
node tools/diagnose-speech.mjs tts
```

`azure-host` creates a fixed test WAV in `firmware/build/azure-test-speech.wav`.
`azure-device` serves only that WAV briefly over the LAN, then uploads it from
the device to Azure. `recognize` captures up to 8 seconds of live microphone
audio. `mic` additionally saves a diagnostic microphone WAV and sends it to
Azure from the host to separate capture/VAD failures from transport failures.
Do not run probes while an application is conducting a conversation.
`cache-check` tests the 60-second idle eviction, and reports inconclusive if
application speech resumes during that window. `logs` and `status` are passive.

Host regression:

```sh
c++ -std=c++17 -O2 -Ifirmware/components/bindings_speech/src firmware/components/bindings_speech/tests/speech_core_test.cpp -o firmware/build/speech-core-test
firmware/build/speech-core-test firmware/build/srmodels/srmodels.bin firmware/build/device-microphone.wav
node firmware/components/bindings_speech/tests/check-prelude.mjs
node examples/07-obeing-harness/test.mjs
```

A successful fixed phrase is evidence of working capture/VAD/Azure transport,
not a claim about recognition accuracy in all noise conditions. MultiNet7 is
a command model with the custom phrase, not a dedicated trained wake-word
model. Full enterprise login and extended conversational traffic require their
own end-to-end measurements; HTTPS timing here is an Azure endpoint test.
