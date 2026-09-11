// voice/stt.js
// AirC Speech-to-Text module.
//
// Captures raw microphone audio via getUserMedia + a small local
// voice-activity detector (VAD), then transcribes each detected utterance
// fully on-device with Whisper (via Transformers.js/ONNX-WASM) — no
// ElevenLabs Scribe call, no API key, no per-utterance network round trip.
//
// This deliberately does NOT use the browser's built-in SpeechRecognition
// API. On Android, every recognition.start()/stop() call plays an
// OS-level chime with no way to silence it from JavaScript — and a
// hands-free app that's stopping/starting recognition on every reply
// turn means that chime fires constantly. Raw getUserMedia capture has
// no such sound (just a silent "mic in use" indicator), so this is the
// only way to make listening genuinely quiet.

import { pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";

// Multilingual Whisper (NOT the ".en" variants, which are English-only).
// "tiny" is the smallest/fastest download (~75MB, cached after first run) —
// bump to "Xenova/whisper-base" for noticeably better Hindi/Bengali accuracy
// at the cost of a bigger one-time download (~145MB).
const WHISPER_MODEL = "Xenova/whisper-tiny";
const WHISPER_SAMPLE_RATE = 16000;

// Loaded once per page load and shared by every AirCSTT instance — the
// model download/compile is the expensive part, so kick it off as early as
// possible (see start()) and reuse the same pipeline for every utterance.
let _asrPipelinePromise = null;
function getAsrPipeline() {
    if (!_asrPipelinePromise) {
        _asrPipelinePromise = pipeline("automatic-speech-recognition", WHISPER_MODEL);
    }
    return _asrPipelinePromise;
}

const START_THRESHOLD = 0.035;   // RMS-ish level that counts as "speech begins"
const STOP_THRESHOLD = 0.02;     // level that counts as "gone quiet" once talking
const START_HOLD_MS = 120;       // must stay above START_THRESHOLD this long to count
const SILENCE_HOLD_MS = 650;     // must stay below STOP_THRESHOLD this long to finalize (was 900 — trimmed for a snappier turn-around)
const MIN_UTTERANCE_MS = 300;    // discard anything shorter (taps, coughs, noise)
const MAX_UTTERANCE_MS = 20000;  // hard cap so a stuck recording can't run forever
const MIN_BLOB_BYTES = 800;      // discard near-empty recordings

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];

function pickMimeType() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    return MIME_CANDIDATES.find((t) => t === "" || MediaRecorder.isTypeSupported(t)) || "";
}

// ---------------------------------------------------------------------
// Fallback path: if the Whisper model can't be fetched (CDN blocked,
// firewall, offline), use the browser's built-in SpeechRecognition API so
// voice input still works. Only used when Whisper is unavailable — the
// primary path stays 100% on-device as designed.
// ---------------------------------------------------------------------
function nativeASRSupported() {
    return typeof (window.SpeechRecognition || window.webkitSpeechRecognition) === "function";
}

const ASR_DECIDE_TIMEOUT_MS = 8000; // give Whisper this long to (re)start before falling back


export class AirCSTT {
    /**
     * @param {object} config - AirCConfig instance (used for the
     *   ElevenLabs API key and the current language, read fresh on every
     *   transcription request).
     */
    constructor(config) {
        this.config = config;

        this._stream = null;
        this._audioCtx = null;
        this._analyser = null;
        this._sourceNode = null;
        this._data = null;
        this._ready = false;

        this._recorder = null;
        this._chunks = [];
        this._recording = false;
        this._speechStartedAt = 0;
        this._aboveSince = 0;
        this._belowSince = 0;

        this._loopId = null;
        this._active = false;
        this._native = null;
        this._nativeMode = false;
        this._pendingASRDecision = null;

        // Callbacks the app controller hooks into.
        this.onFinalTranscript = null; // (text) => void
        this.onError = null;           // (message) => void
    }

    /** Starts (or resumes) listening. Safe to call repeatedly — a no-op if already active. */
    async start() {
        if (this._active) return;
        this._active = true;

        // Decide once per page load whether Whisper is usable. If its CDN
        // download times out/fails, fall back to the browser's own speech
        // recognition so voice input never just dies.
        if (!this._pendingASRDecision) {
            this._pendingASRDecision = (async () => {
                try {
                    await Promise.race([
                        getAsrPipeline(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error("asr-timeout")), ASR_DECIDE_TIMEOUT_MS))
                    ]);
                    return "whisper";
                } catch (err) {
                    console.warn("[AirCSTT] Whisper unavailable, falling back to browser speech recognition.", err);
                    return nativeASRSupported() ? "native" : "none";
                }
            })();
        }
        const mode = await this._pendingASRDecision;

        if (mode === "native") {
            this._startNativeASR();
            return;
        }

        // Whisper model already being downloaded/compiled above; just make
        // sure the mic graph is ready before the VAD loop starts.
        try {
            await this._ensureGraph();
        } catch (err) {
            this._active = false;
            console.warn("[AirCSTT] Could not access microphone.", err);
            if (typeof this.onError === "function") this.onError("Mic access needed for AirC to work.");
            return;
        }
        this._aboveSince = 0;
        this._belowSince = 0;
        this._loop();
    }

    /**
     * Pauses listening (and drops any in-progress recording) without
     * releasing the microphone — resuming with start() is instant and
     * silent. Use this while AirClia is speaking.
     */
    stop() {
        this._active = false;
        if (this._loopId) {
            cancelAnimationFrame(this._loopId);
            this._loopId = null;
        }
        if (this._recording) this._abortRecording();
        if (this._native || this._nativeMode) this._stopNativeASR();
    }

    /**
     * Fully releases the microphone (stops all tracks). start() will
     * re-request getUserMedia next time — silent, no prompt, since
     * permission was already granted once during onboarding.
     */
    release() {
        this.stop();
        this._stopNativeASR();
        if (this._sourceNode) { try { this._sourceNode.disconnect(); } catch (e) {} }
        if (this._analyser) { try { this._analyser.disconnect(); } catch (e) {} }
        if (this._stream) this._stream.getTracks().forEach((t) => { try { t.stop(); } catch (e) {} });
        this._stream = null;
        this._sourceNode = null;
        this._analyser = null;
        this._ready = false;
    }

    isActive() {
        return this._active;
    }

    // -----------------------------------------------------------------
    // Native SpeechRecognition fallback (only when Whisper can't load)
    // -----------------------------------------------------------------
    _startNativeASR() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { this._nativeMode = false; return; }
        this._nativeMode = true;
        const rec = new SR();
        rec.continuous = true;
        rec.interimResults = false;
        rec.lang = this.config.get("language") || "hi-IN";
        rec.onresult = (e) => {
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const res = e.results[i];
                if (res.isFinal && res[0] && res[0].transcript) {
                    const text = res[0].transcript.trim();
                    if (text && typeof this.onFinalTranscript === "function") this.onFinalTranscript(text);
                }
            }
        };
        rec.onerror = (e) => {
            if (!this._active) return;
            if (e.error === "not-allowed" || e.error === "service-not-allowed") {
                if (typeof this.onError === "function") this.onError("Mic access needed for AirC to work.");
            }
        };
        rec.onend = () => {
            // Auto-restart so listening is continuous — AirC's stop() flips
            // _active to false, which is what actually ends the loop.
            if (this._active && this._nativeMode) {
                try { rec.start(); } catch (err) { /* ignore */ }
            }
        };
        this._native = rec;
        try { rec.start(); } catch (err) { /* ignore */ }
    }

    _stopNativeASR() {
        this._nativeMode = false;
        if (this._native) {
            try { this._native.stop(); } catch (err) { /* ignore */ }
            this._native = null;
        }
    }

    async _ensureGraph() {
        if (this._ready) return;
        this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!this._audioCtx) this._audioCtx = new Ctx();
        if (this._audioCtx.state === "suspended") { try { await this._audioCtx.resume(); } catch (e) {} }

        this._sourceNode = this._audioCtx.createMediaStreamSource(this._stream);
        this._analyser = this._audioCtx.createAnalyser();
        this._analyser.fftSize = 512;
        this._sourceNode.connect(this._analyser);
        this._data = new Uint8Array(this._analyser.fftSize);

        this._ready = true;
    }

    _currentLevel() {
        this._analyser.getByteTimeDomainData(this._data);
        let sum = 0;
        for (let i = 0; i < this._data.length; i++) {
            const v = (this._data[i] - 128) / 128;
            sum += v * v;
        }
        return Math.sqrt(sum / this._data.length); // ~0 (silence) to ~1 (loud)
    }

    _loop() {
        this._loopId = requestAnimationFrame(() => this._tick());
    }

    _tick() {
        if (!this._active || !this._analyser) { this._loopId = null; return; }

        const now = performance.now();
        const level = this._currentLevel();

        if (!this._recording) {
            if (level > START_THRESHOLD) {
                if (!this._aboveSince) this._aboveSince = now;
                if (now - this._aboveSince >= START_HOLD_MS) {
                    this._aboveSince = 0;
                    this._startRecording(now);
                }
            } else {
                this._aboveSince = 0;
            }
        } else {
            if (level < STOP_THRESHOLD) {
                if (!this._belowSince) this._belowSince = now;
                if (now - this._belowSince >= SILENCE_HOLD_MS) {
                    this._belowSince = 0;
                    this._finishRecording();
                }
            } else {
                this._belowSince = 0;
            }
            if (this._recording && now - this._speechStartedAt >= MAX_UTTERANCE_MS) this._finishRecording();
        }

        this._loop();
    }

    _startRecording(now) {
        if (typeof MediaRecorder === "undefined") {
            if (typeof this.onError === "function") this.onError("Voice input isn't supported on this browser.");
            return;
        }
        const mimeType = pickMimeType();
        try {
            this._recorder = mimeType ? new MediaRecorder(this._stream, { mimeType }) : new MediaRecorder(this._stream);
        } catch (err) {
            console.warn("[AirCSTT] MediaRecorder failed to start.", err);
            return;
        }
        this._chunks = [];
        this._recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this._chunks.push(e.data); };
        this._recorder.start();
        this._recording = true;
        this._speechStartedAt = now;
        this._belowSince = 0;
    }

    _abortRecording() {
        if (this._recorder && this._recorder.state !== "inactive") {
            try { this._recorder.ondataavailable = null; this._recorder.onstop = null; this._recorder.stop(); } catch (e) {}
        }
        this._recorder = null;
        this._chunks = [];
        this._recording = false;
    }

    _finishRecording() {
        if (!this._recorder) { this._recording = false; return; }
        const recorder = this._recorder;
        const startedAt = this._speechStartedAt;
        const mimeType = recorder.mimeType || "audio/webm";
        this._recording = false;
        this._recorder = null;

        recorder.onstop = async () => {
            const durationMs = performance.now() - startedAt;
            const blob = new Blob(this._chunks, { type: mimeType });
            this._chunks = [];
            // Too short or basically empty — almost certainly noise, not speech.
            if (durationMs < MIN_UTTERANCE_MS || blob.size < MIN_BLOB_BYTES) return;
            await this._transcribe(blob, mimeType);
        };
        try { recorder.stop(); } catch (e) {}
    }

    async _transcribe(blob, mimeType) {
        try {
            const audioData = await this._decodeToWhisperPCM(blob);
            if (!audioData || !audioData.length) return;

            const asr = await getAsrPipeline();
            const langCode = (this.config.get("language") || "hi-IN").split("-")[0]; // "hi" | "bn" | "en"

            const result = await asr(audioData, {
                language: langCode,
                task: "transcribe",
                chunk_length_s: 20 // matches MAX_UTTERANCE_MS
            });

            const text = ((result && result.text) || "").trim();
            if (text && typeof this.onFinalTranscript === "function") this.onFinalTranscript(text);
        } catch (err) {
            console.warn("[AirCSTT] Whisper transcription failed.", err);
            if (typeof this.onError === "function") this.onError("Couldn't hear that clearly — try again.");
        }
    }

    /**
     * Decodes a recorded blob (webm/opus or mp4, whatever the browser gave
     * MediaRecorder) into a mono Float32Array at 16kHz — the exact format
     * Whisper's feature extractor expects. Uses a scratch AudioContext for
     * decoding (kept separate from the always-open mic-analysis context)
     * and an OfflineAudioContext to resample down to 16kHz.
     */
    async _decodeToWhisperPCM(blob) {
        const arrayBuffer = await blob.arrayBuffer();
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const decodeCtx = new Ctx();
        let decoded;
        try {
            decoded = await decodeCtx.decodeAudioData(arrayBuffer);
        } finally {
            decodeCtx.close().catch(() => {});
        }

        if (decoded.sampleRate === WHISPER_SAMPLE_RATE && decoded.numberOfChannels === 1) {
            return decoded.getChannelData(0).slice();
        }

        const offline = new OfflineAudioContext(
            1,
            Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE),
            WHISPER_SAMPLE_RATE
        );
        const src = offline.createBufferSource();
        src.buffer = decoded;
        src.connect(offline.destination);
        src.start(0);
        const rendered = await offline.startRendering();
        return rendered.getChannelData(0).slice();
    }
}
