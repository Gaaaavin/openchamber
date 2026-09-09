# Dictation module

Server-authoritative speech-to-text for the chat composer, plus local
text-to-speech. The client streams 16 kHz mono PCM16 chunks (base64) over a
WebSocket while the user speaks; the server buffers them and transcribes each
segment exactly once, when the segment is committed.

Transcription runs once per committed segment, not on the growing audio
buffer. Re-decoding that buffer would cost O(n^2) work for a result the final
decode replaces. The composer overlay shows committed segments live while
recording and transcribing, in a normal-foreground block capped at three lines
with scrolling that follows new text. It inserts the full transcript after
stop and finalization, not as segments arrive.

Local TTS (Kokoro and Piper/VITS via sherpa-onnx OfflineTts) runs in the same
worker process and is exposed as `POST /api/dictation/tts/speak` (JSON
`{text, speakerId?, speed?, model?, language?, languageSample?}` → WAV bytes; 503 with
`reasonCode` while the model is downloading). TTS models live in the same
catalog/downloader as STT models (`local/model-catalog.js`
`LOCAL_TTS_MODEL_CATALOG`) and are managed by the same status/download/delete
routes.

Each TTS catalog entry declares the `languages` it speaks. With
`language: 'auto'` the service detects the language of `languageSample` — the
whole message the chunk belongs to, sent by the client with every chunk — or
of `text` when no sample is given
(`../tts/language-detect.js`, script plus function-word scoring, no
dependencies) and keeps the caller's model when it speaks that language;
otherwise it switches to the catalog model for the language, downloading it on
first use like any other model, and starts from that model's default speaker
(`defaultSpeakerByLanguage`) instead of the caller's speaker id. A language no
catalog model covers keeps the caller's model, so text is always spoken. The
response carries `X-Speech-Model` and `X-Speech-Language`.

## Ownership

- `runtime.js` — registers `GET /api/dictation/status`,
  `POST /api/dictation/models/:modelId/download`, and the
  `/api/dictation/ws` WebSocket endpoint (auth-gated the same way as the
  terminal WS: UI session token or `oc_url_token`, plus origin check).
  Created from the startup pipeline (`startup-pipeline-runtime.js`) before
  the generic OpenCode proxy so routes are not shadowed.
- `stream-manager.js` — `DictationStreamManager`, one per WS connection.
  Chunk reordering by `seq` + ack, resampling to the provider rate, segment
  splitting, silence suppression by PCM peak, partial-transcript
  concatenation, adaptive finalization timeout.
- `service.js` — provider resolution and readiness. Providers:
  - `local` (default): sherpa-onnx in a forked worker process. Qwen3-ASR 0.6B
    int8 is the default model; Parakeet TDT and Whisper remain selectable.
    Models auto-download in the background on first use; while missing, the
    stream fails with `reasonCode: 'model_download_in_progress'` and the
    status route reports per-model install/download state.
  - `openai-compatible`: buffered per-segment transcription against any
    OpenAI-compatible `/v1/audio/transcriptions` endpoint
    (`openai-compatible-session.js`, reuses `../tts/stt.js`).
- `local/` — worker process + client (IPC, idle shutdown TTL), sherpa
  recognizer engine and segment session (one decode per committed segment),
  model catalog and downloader. The native `sherpa-onnx-node` addon is only
  ever loaded inside the worker process.
- `local/model-catalog.js` — local STT catalog. Qwen3-ASR uses
  `qwen3_asr`; Parakeet uses `nemo_transducer`; Whisper uses `whisper`.
- `audio.js` — PCM16 helpers: format parsing, peak, WAV wrapping, streaming
  linear resampler.

## WebSocket protocol (JSON text frames)

Client → server: `start {dictationId, format, options}`,
`chunk {dictationId, seq, audio}`, `finish {dictationId, finalSeq}`,
`cancel {dictationId}`, `ping`.

Server → client: `ready`, `ack {ackSeq}`, `partial {text}`,
`finish_accepted {timeoutMs}`, `final {text}`,
`error {error, retryable, reasonCode?}`, `pong`.

`options` in `start` carries the client-selected provider config:
`{ provider: 'local' | 'openai-compatible', language?, localModel?,
openaiCompatible?: { baseUrl, model, apiKey } }`.

## Segmentation

A dictation is one segment unless it runs long. The manager defaults remain
60 s minimum and 90 s maximum for Parakeet. Local catalog entries can declare
`segment: { minSeconds, maxSeconds }`, exposed as read-only `segmentHints` on
the worker-backed session. The manager resolves missing bounds from its
defaults and falls back to both defaults if either bound is non-finite,
non-positive, or the minimum exceeds the maximum. Sessions without hints,
including OpenAI-compatible sessions, retain the defaults.

Qwen3-ASR uses 15/30 s bounds so committed text appears sooner in the live
overlay and the tail takes less time to decode after stop. The bounds limit
decode latency, not token use. The
512-token limit was sherpa's default `max_total_len`, not a fixed decoder
limit: the exported KV cache is dynamic. The recognizer now sets
`maxTotalLen: 2048` and `maxNewTokens: 1024`. At 13 audio tokens/s plus about
3.2 Mandarin text tokens/s and 20 prompt tokens, 60 s uses roughly 1000
tokens and 120 s roughly 1970. The tokenizer merges two-character words.

Single-call measurements on an M2 Air with four threads,
`qwen3-asr-0.6b-int8`, sherpa-onnx-node 1.13.7, and `maxTotalLen` raised to
2048 or 4096:

| Audio | Decode | RTF | Max RSS |
|---|---|---|---|
| 10 s | 1.1 s | 0.10 | 1.8 GB |
| 30 s | 4.4 s | 0.15 | 2.9 GB |
| 60 s | 12.2 s | 0.20 | 2.9 GB |
| 90 s | 24.6 s | 0.27 | 3.4 GB |
| 170 s | 77.8 s | 0.46 | 4.1 GB |

Decode time grows superlinearly. A 30 s segment takes about 4.4 s, well below
the worker's 60 s request timeout. Decode blocks worker IPC synchronously,
so queued appends wait too; the timeout leaves headroom for thermal
throttling on fanless machines. The tail segment's decode is what the user
waits for after stopping.

Once a segment reaches its minimum, a whole chunk with PCM peak below 300
is appended and committed first. Otherwise the manager scans the resampled
chunk in full 200 ms windows and splits at the end of the first quiet window
that reaches the minimum. Quiet means below -20 dB relative to the segment
peak so far, with a floor of 300. The remainder starts the next segment with
its own byte and peak accounting. The hard cap remains the final rule when
no pause qualifies. Finish disables auto-splitting while missing chunks drain.

Parakeet's bounds exist because it is a full-attention conformer: decode cost
and peak memory grow quadratically with segment length. Measured on Parakeet
v3 int8 with 2 threads: 60 s took 2.1 s and +90 MB, 180 s took 9.3 s and
+490 MB, 300 s took 21.3 s and +1.5 GB. Committed segments decode while the
user is still speaking, so only the tail is left to transcribe on stop.

Qwen3-ASR uses the Mac's performance-core count from
`hw.perflevel0.physicalcpu`, clamped to 2-8 threads. If that value is not
available, it uses up to four logical CPUs. Other local STT models keep the
existing two-thread policy. On an M2 Air, four performance-core threads decode
faster than two threads or configurations that also include efficiency cores.

## Invariants

- Never load `sherpa-onnx-node` in the main server process.
- Transcription happens on commit only; sessions never emit non-final
  transcripts. The `partial` messages a client receives are the concatenation
  of already-committed segments' final transcripts. The overlay displays them
  during recording and uploading; they also allow salvage if dictation fails.
- The stream manager acks only the highest contiguous seq; the client is
  expected to retain unacked segments for retry/replay.
- Silence-only segments (peak < 300) are cleared, never committed, so
  Whisper-style providers do not hallucinate on silence.
- Model files live under `~/.config/openchamber/speech-models`.
