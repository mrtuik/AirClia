# AirClia — Project Memory

Single-file web app (`AirC.html` + ES modules) — a voice-first AI companion avatar (persona "Clia") that listens, replies via an LLM, and speaks back with lip-synced idle/speaking video. Runs entirely client-side (no backend), configured via a Settings sheet, state in `localStorage`.

## File map
- `AirC.html` — UI (chat/voice screens, Settings sheet, Voice-picker sheet, onboarding), all app wiring/event listeners in one inline `<script type="module">`.
- `config/config.js` — `AirCConfig` class: owns ALL persistent settings (localStorage keys `airc_config_v1`, `airc_voices_v1`, `airc_history_v1`, `airc_sessions_v1`). Nothing else touches localStorage directly.
- `voice/voice.js` — `AirCVoice`: TTS orchestrator/playback (speak/stop/testVoice), instant-interrupt.
- `voice/engines.js` — the 4 TTS engine implementations + built-in voice catalogs.
- `voice/stt.js` — `AirCSTT`: speech-to-text.
- `brain/brain.js` — `AirCBrain`: LLM calls + personality/roast logic.
- `model/model.js` — `AirCModel`: avatar state machine (idle/speaking video swap + subtle nod), driven by TTS audio play/pause/ended events. No Web Audio analysis — just event listeners on the audio element, so any TTS engine's audio works, no CORS/analyser requirements.
- `assets/clia-idle.mp4`, `assets/clia-speaking.mp4` — avatar loop videos.

## STT (speech-to-text)
- **100% on-device**, no API key, no network round-trip per utterance.
- Raw `getUserMedia` mic capture + a small RMS-based voice-activity detector (VAD) — deliberately avoids the browser's built-in `SpeechRecognition` API because on Android it plays an OS chime on every start/stop, which would fire constantly in a hands-free app.
- Transcription: **Whisper (multilingual, `Xenova/whisper-tiny`)** run in-browser via `@huggingface/transformers` (ONNX-WASM), loaded once from CDN (`cdn.jsdelivr.net`) and cached.
- VAD tuning: `START_THRESHOLD=0.035`, `STOP_THRESHOLD=0.02`, needs 120ms above start-threshold to trigger, 650ms of silence to finalize, utterances between 300ms–20s kept.
- Failure modes: mic permission denied, or the Whisper model failing to download from the CDN (network/firewall blocking jsdelivr). **Not related to ElevenLabs at all.**

## TTS (text-to-speech) — 4 engines, added this session
Engine selection lives in `config.tts_engine` (`edge` | `google` | `elevenlabs` | `openai`), voice in `config.voice_id` + `config.selected_voice`. Picked via a tabbed Voice-picker sheet (each tab = one engine, each voice card has a Play-preview button + Select).

| Engine | Key needed? | Free/unlimited? | How it works | Caveat |
|---|---|---|---|---|
| **Microsoft Edge** (default) | No | Yes | Reverse-engineered trial WebSocket (`wss://speech.platform.bing.com/...`) using Microsoft's public "Sec-MS-GEC" trial token algorithm (SHA-256 of 5-min-rounded Windows filetime + a known constant). Streams binary mp3 frames, assembled into a Blob. | **Unofficial.** Can 403 if MS's server rejects the request's Origin/handshake — a static frontend can't fully control that; a small serverless proxy (e.g. Cloudflare Worker) would fix it reliably. Unverified in this sandbox (no network access to test). |
| **Google Translate** | No | Yes | `translate_tts` unofficial endpoint, loaded directly via `<audio src=...>` (not `fetch`, since the endpoint has no CORS headers — but plain audio playback isn't CORS-gated). ~180 char cap per request, so long replies are chunked by sentence and chained via a small `ChainedAudio` facade class. | Unofficial, could be rate-limited/blocked by Google without notice. |
| **ElevenLabs** | Yes (`elevenlabs_api_key`) | No (quota-based) | Official REST API, `POST /v1/text-to-speech/{voiceId}`. 3 curated built-in voices (Sarah/Matilda/Alice) + user can add custom voice IDs. | "ElevenLabs hiccuped" toast = 401/429/5xx after 1 retry — check API key validity/quota. |
| **OpenAI** | Yes (`openai_api_key`) | No | Official REST API, `POST /v1/audio/speech`, model `tts-1`. 6 fixed voices (alloy/echo/fable/onyx/nova/shimmer), no custom IDs. | — |

**Failure behavior (by design, no silent fallback):** if the active engine fails (after 1 quick silent retry for transient blips), `voice.js` fires `onError(kind, err, engine)`. The app shows a toast naming the problem and **reopens the Voice-picker sheet** so the person manually chooses what to do next — it never silently swaps engines/voices on its own.

## Brain (LLM)
- `AirCBrain` calls **OpenRouter** (`openrouter_api_key` + `openrouter_model`, default `openai/gpt-4o-mini`).
- System prompt = "AirC, a voice-first AI companion with a female personality," live spoken conversation framing.
- Personality/roast intensity (`mild`/`normal`/`savage`) with canned nudge lines for silence and low-effort ("yeah"/one-word) replies, plus supportive fallback lines. Keeps ~14 turns of in-memory (not persisted) history.

## Config gating
- `config.isComplete()` / `canRunWithFallback()` now only require the **brain** (OpenRouter key + model) — voice is no longer a hard gate since the default engine (Edge) is free/keyless.
- `config.hasVoiceSelected()` = `voice_setup_complete && selected_voice`.
- Voice library: `config.getVoices(engine)` = built-ins (from `voice/engines.js`) + custom voices, stored **per engine** in `airc_voices_v1` (only ElevenLabs currently supports adding custom voice IDs).

## Known open item
Edge TTS 403 fix is implemented per the standard public algorithm but **unverified** — no network in the dev sandbox to test it live. If it still 403s on-device, root cause is very likely Microsoft's server-side Origin check, and the durable fix is a tiny proxy, not more client code.
