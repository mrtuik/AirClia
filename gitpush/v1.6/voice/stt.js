// voice/stt.js
// AirC Speech-to-Text module.
//
// Captures raw microphone audio via getUserMedia + a small local
// voice-activity detector (VAD), and sends each detected utterance to
// ElevenLabs' Speech-to-Text (Scribe) API for transcription.
//
// This deliberately does NOT use the browser's built-in SpeechRecognition
// API. On Android, every recognition.start()/stop() call plays an
// OS-level chime with no way to silence it from JavaScript — and a
// hands-free app that's stopping/starting recognition on every reply
// turn means that chime fires constantly. Raw getUserMedia capture has
// no such sound (just a silent "mic in use" indicator), so this is the
// only way to make listening genuinely quiet.

const START_THRESHOLD = 0.035;   // RMS-ish level that counts as "speech begins"
const STOP_THRESHOLD = 0.02;     // level that counts as "gone quiet" once talking
const START_HOLD_MS = 120;       // must stay above START_THRESHOLD this long to count
const SILENCE_HOLD_MS = 900;     // must stay below STOP_THRESHOLD this long to finalize
const MIN_UTTERANCE_MS = 300;    // discard anything shorter (taps, coughs, noise)
const MAX_UTTERANCE_MS = 20000;  // hard cap so a stuck recording can't run forever
const MIN_BLOB_BYTES = 800;      // discard near-empty recordings

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];

function pickMimeType() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    return MIME_CANDIDATES.find((t) => t === "" || MediaRecorder.isTypeSupported(t)) || "";
}

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

        // Callbacks the app controller hooks into.
        this.onFinalTranscript = null; // (text) => void
        this.onError = null;           // (message) => void
    }

    /** Starts (or resumes) listening. Safe to call repeatedly — a no-op if already active. */
    async start() {
        if (this._active) return;
        this._active = true;
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
    }

    /**
     * Fully releases the microphone (stops all tracks). start() will
     * re-request getUserMedia next time — silent, no prompt, since
     * permission was already granted once during onboarding.
     */
    release() {
        this.stop();
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
        const apiKey = this.config.get("elevenlabs_api_key");
        if (!apiKey) {
            if (typeof this.onError === "function") this.onError("Add your ElevenLabs API key to enable voice input.");
            return;
        }
        const langCode = (this.config.get("language") || "hi-IN").split("-")[0];
        const ext = mimeType.includes("mp4") ? "mp4" : "webm";

        const form = new FormData();
        form.append("model_id", "scribe_v1");
        if (langCode) form.append("language_code", langCode);
        form.append("file", blob, `utterance.${ext}`);

        try {
            const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
                method: "POST",
                headers: { "xi-api-key": apiKey },
                body: form
            });
            if (!res.ok) {
                const errText = await res.text().catch(() => "");
                throw new Error(`ElevenLabs STT error ${res.status}: ${errText}`);
            }
            const data = await res.json();
            const text = ((data && data.text) || "").trim();
            if (text && typeof this.onFinalTranscript === "function") this.onFinalTranscript(text);
        } catch (err) {
            console.warn("[AirCSTT] Transcription failed.", err);
            if (typeof this.onError === "function") this.onError("Couldn't hear that clearly — try again.");
        }
    }
}
