// voice/voice.js
// AirC Voice Module
// Owns all speech OUTPUT: picks an engine (ElevenLabs / Microsoft Edge /
// Google Translate / OpenAI), calls voice/engines.js to synthesize, and
// handles playback + instant interruption.
//
// Network-backed engines can fail in two different places:
// 1) while requesting/generated audio, or
// 2) later, when the returned audio actually starts playing.
//
// The original code only fell back to the device voice for (1). Google
// Translate usually "succeeds" synchronously because it just returns <audio>
// URLs, so real failures often happen at (2) and surfaced as "Voice
// hiccuped" even though a safe device-voice fallback existed. This module now
// applies the same browser-voice fallback to playback failures as well.

import { synthesize, BUILT_IN_VOICES, ENGINE_INFO } from "./engines.js";

const API_KEY_CONFIG_FIELD = {
    elevenlabs: "elevenlabs_api_key",
    openai: "openai_api_key",
    edge: null,
    google: null,
    browser: null
};

export class AirCVoice {
    /**
     * @param {AirCConfig} config
     */
    constructor(config) {
        this.config = config;
        this._audio = null;
        this._currentObjectUrl = null;
        this._speaking = false;
        this._gen = 0;

        // Optional callbacks the app controller can hook into.
        this.onStart = null;
        this.onEnd = null;
        // onError(kind, err, engine)
        // - kind can be "no-key", an engine name, or "playback"
        // - engine is the engine that the user selected / that failed
        this.onError = null;
    }

    isSpeaking() {
        return this._speaking;
    }

    /**
     * Select the active voice. Accepts a voice entry
     * ({ engine, id, name, ... }).
     */
    setVoice(voice) {
        if (!voice) return null;
        this.config.setMany({
            tts_engine: voice.engine,
            voice_id: voice.id || "",
            selected_voice: voice.name || "AirClia Voice",
            voice_setup_complete: true
        });
        this.config.save();
        return this.getCurrentVoice();
    }

    /**
     * Returns the currently selected voice entry from the config voice
     * library (built-ins + any custom voices for that engine).
     */
    getCurrentVoice() {
        const engine = this.config.get("tts_engine") || "edge";
        const id = this.config.get("voice_id") || "";
        const name = this.config.get("selected_voice") || "";
        const found = this.config.getVoices(engine).find((v) => v.id === id);
        if (found) return { ...found, engine };
        return {
            engine,
            id,
            name: name || "AirClia Voice",
            description: ENGINE_INFO[engine]?.label || "",
            builtIn: false
        };
    }

    /**
     * Returns the currently-playing <audio>-like element, or null if
     * nothing is playing.
     */
    getAudioElement() {
        return this._audio;
    }

    _apiKeyFor(engine) {
        const field = API_KEY_CONFIG_FIELD[engine];
        return field ? this.config.get(field) : null;
    }

    /**
     * Speak the given text with whatever engine is currently selected.
     * Falls back to the device voice if a network-backed provider fails
     * either during synthesis OR when playback begins.
     * @param {string} text
     */
    async speak(text) {
        if (!text || !text.trim()) return;

        this.stop();

        const myGen = ++this._gen; // this call's ticket

        const requestedEngine = this.config.get("tts_engine") || "edge";
        const voiceId = this.config.get("voice_id");
        const language = this.config.get("language") || "en-US";
        const synthesisVoiceId = requestedEngine === "browser" ? language : voiceId;
        const info = ENGINE_INFO[requestedEngine];

        if (info?.needsKey && !this._apiKeyFor(requestedEngine)) {
            if (this.onError) this.onError("no-key", new Error(`${info.label} needs an API key`), requestedEngine);
            return;
        }

        try {
            let audio;
            let activeEngine = requestedEngine;
            try {
                audio = await this._synthesizeWithRetry(requestedEngine, text, synthesisVoiceId, myGen);
            } catch (providerError) {
                if (requestedEngine === "browser") throw providerError;
                console.warn(`[AirCVoice] ${requestedEngine} unavailable; using device voice.`, providerError);
                activeEngine = "browser";
                audio = await synthesize("browser", text, language);
            }
            if (myGen !== this._gen) return; // superseded while synthesizing
            this._bindAndPlay(audio, myGen, {
                text,
                language,
                requestedEngine,
                activeEngine,
                allowDeviceFallback: activeEngine !== "browser",
                preview: false
            });
        } catch (err) {
            console.error(`[AirCVoice] ${requestedEngine} failed.`, err);
            if (myGen === this._gen) {
                if (this.onError) this.onError(requestedEngine, err, requestedEngine);
                if (this.onEnd) this.onEnd();
            }
        }
    }

    async _synthesizeWithRetry(engine, text, voiceId, myGen, attempt = 0) {
        // Transient blips (429/5xx, dropped connections) are common on all
        // four of these backends — one quick silent retry clears most of
        // them before we surface an error.
        try {
            return await synthesize(engine, text, voiceId, this._apiKeyFor(engine));
        } catch (err) {
            if (attempt < 1 && myGen === this._gen) {
                await new Promise((r) => setTimeout(r, 500));
                return this._synthesizeWithRetry(engine, text, voiceId, myGen, attempt + 1);
            }
            throw err;
        }
    }

    _bindAndPlay(audio, myGen, context = {}) {
        if (myGen !== this._gen) return; // superseded — discard

        this._audio = audio;
        this._speaking = true;

        audio.addEventListener("play", () => {
            if (myGen === this._gen && this.onStart) this.onStart();
        });
        audio.addEventListener("ended", () => {
            if (myGen !== this._gen) return;
            this._speaking = false;
            this._audio = null;
            this._cleanupObjectUrl();
            if (this.onEnd) this.onEnd();
        });
        audio.addEventListener("error", async (e) => {
            if (myGen !== this._gen) return;

            const failedEngine = context.requestedEngine || context.activeEngine || "browser";

            this._speaking = false;
            try {
                if (this._audio && typeof this._audio.pause === "function") this._audio.pause();
            } catch (err) {
                // ignore
            }
            this._audio = null;
            this._cleanupObjectUrl();

            if (context.allowDeviceFallback && failedEngine !== "browser") {
                try {
                    console.warn(`[AirCVoice] ${failedEngine} playback failed; using device voice.`, e);
                    const fallbackAudio = await synthesize("browser", context.text || "", context.language || "en-US");
                    if (myGen !== this._gen) return;
                    this._bindAndPlay(fallbackAudio, myGen, {
                        ...context,
                        activeEngine: "browser",
                        allowDeviceFallback: false
                    });
                    return;
                } catch (fallbackErr) {
                    console.error("[AirCVoice] Device voice fallback failed.", fallbackErr);
                    if (this.onError) this.onError(failedEngine, fallbackErr, failedEngine);
                    if (this.onEnd) this.onEnd();
                    return;
                }
            }

            if (this.onError) this.onError("playback", e, failedEngine);
            if (this.onEnd) this.onEnd();
        });

        // Real <audio> elements built from a blob need play() called;
        // ChainedAudio (Google) starts its own first chunk on play().
        let p;
        try { p = audio.play(); } catch (err) {
            audio.dispatchEvent(new Event("error"));
        }
        if (p && typeof p.catch === "function") {
            p.catch(() => audio.dispatchEvent(new Event("error")));
        }
    }

    /**
     * Test/preview a specific voice without changing the selected one.
     * Used by both the Settings "Test voice" button and the per-voice
     * "Play" preview in the voice picker.
     */
    async testVoice(sampleText = "Hey, this is what I sound like.", override = null) {
        this.stop();
        const requestedEngine = override?.engine || this.config.get("tts_engine") || "edge";
        const voiceId = override?.id || this.config.get("voice_id");
        const info = ENGINE_INFO[requestedEngine];
        const apiKey = override?.apiKey ?? this._apiKeyFor(requestedEngine);
        const language = this.config.get("language") || "en-US";

        if (info?.needsKey && !apiKey) {
            const err = new Error(`Add your ${info.label} API key first.`);
            if (this.onError) this.onError("no-key", err, requestedEngine);
            throw err;
        }

        const myGen = ++this._gen;
        const synthesisVoiceId = requestedEngine === "browser" ? language : voiceId;
        let audio;
        let activeEngine = requestedEngine;
        try {
            audio = await synthesize(requestedEngine, sampleText, synthesisVoiceId, apiKey);
        } catch (providerError) {
            if (requestedEngine === "browser") throw providerError;
            console.warn(`[AirCVoice] ${requestedEngine} preview unavailable; using device voice.`, providerError);
            activeEngine = "browser";
            audio = await synthesize("browser", sampleText, language);
        }
        this._bindAndPlay(audio, myGen, {
            text: sampleText,
            language,
            requestedEngine,
            activeEngine,
            allowDeviceFallback: activeEngine !== "browser",
            preview: true
        });
    }
}

export { BUILT_IN_VOICES, ENGINE_INFO };
