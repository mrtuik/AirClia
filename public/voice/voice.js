// voice/voice.js
// AirC Voice Module
// Owns all speech OUTPUT: picks an engine (ElevenLabs / Microsoft Edge /
// Google Translate / OpenAI), calls voice/engines.js to synthesize, and
// handles playback + instant interruption.
//
// Deliberately does NOT silently fall back to another engine on failure —
// per product decision, a failed engine surfaces an error and hands control
// back to the app (onError), which opens the voice picker so the person
// chooses what to do next ("ask me first", not a silent swap).

import { synthesize, BUILT_IN_VOICES, ENGINE_INFO } from "./engines.js";

const API_KEY_CONFIG_FIELD = {
    elevenlabs: "elevenlabs_api_key",
    openai: "openai_api_key",
    edge: null,
    google: null
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
        // onError(kind, err) — kind is "no-key" (engine needs a key that's
        // missing) or the engine name itself (synthesis/playback failed).
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
     * No silent cross-engine fallback — a failure calls onError and stops.
     * @param {string} text
     */
    async speak(text) {
        if (!text || !text.trim()) return;

        this.stop();

        const myGen = ++this._gen; // this call's ticket

        const engine = this.config.get("tts_engine") || "edge";
        const voiceId = this.config.get("voice_id");
        const synthesisVoiceId = engine === "browser" ? (this.config.get("language") || "en-US") : voiceId;
        const info = ENGINE_INFO[engine];

        if (info?.needsKey && !this._apiKeyFor(engine)) {
            if (this.onError) this.onError("no-key", new Error(`${info.label} needs an API key`), engine);
            return;
        }

        try {
            let audio;
            try {
                audio = await this._synthesizeWithRetry(engine, text, synthesisVoiceId, myGen);
            } catch (providerError) {
                // Network TTS can fail due to CORS, quota, regional blocks, or
                // an unofficial endpoint changing. Keep the assistant audible.
                if (engine === "browser") throw providerError;
                console.warn(`[AirCVoice] ${engine} unavailable; using device voice.`, providerError);
                audio = await synthesize("browser", text, this.config.get("language") || "en-US");
            }
            if (myGen !== this._gen) return; // superseded while synthesizing
            this._bindAndPlay(audio, myGen);
        } catch (err) {
            console.error(`[AirCVoice] ${engine} failed.`, err);
            if (myGen === this._gen) {
                if (this.onError) this.onError(engine, err, engine);
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

    _bindAndPlay(audio, myGen) {
        if (myGen !== this._gen) return; // superseded — discard

        this._audio = audio;
        this._speaking = true;

        audio.addEventListener("play", () => { if (myGen === this._gen && this.onStart) this.onStart(); });
        audio.addEventListener("ended", () => {
            if (myGen !== this._gen) return;
            this._speaking = false;
            this._cleanupObjectUrl();
            if (this.onEnd) this.onEnd();
        });
        audio.addEventListener("error", (e) => {
            if (myGen !== this._gen) return;
            this._speaking = false;
            this._cleanupObjectUrl();
            if (this.onError) this.onError("playback", e);
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
     * Immediately stop any speech in progress. Must be fast — this is what
     * makes the interrupt system feel instant.
     */
    stop() {
        this._gen++;
        if (this._audio) {
            try {
                this._audio.pause();
                this._audio.currentTime = 0;
            } catch (err) {
                // ignore
            }
            this._audio = null;
        }
        this._cleanupObjectUrl();
        this._speaking = false;
    }

    _cleanupObjectUrl() {
        if (this._currentObjectUrl) {
            URL.revokeObjectURL(this._currentObjectUrl);
            this._currentObjectUrl = null;
        }
    }

    /**
     * Test/preview a specific voice without changing the selected one.
     * Used by both the Settings "Test voice" button and the per-voice
     * "Play" preview in the voice picker. Throws on failure so the caller
     * can show a useful error.
     */
    async testVoice(sampleText = "Hey, this is what I sound like.", override = null) {
        this.stop();
        const engine = override?.engine || this.config.get("tts_engine") || "edge";
        const voiceId = override?.id || this.config.get("voice_id");
        const info = ENGINE_INFO[engine];
        const apiKey = override?.apiKey ?? this._apiKeyFor(engine);

        if (info?.needsKey && !apiKey) {
            const err = new Error(`Add your ${info.label} API key first.`);
            if (this.onError) this.onError("no-key", err, engine);
            throw err;
        }

        const myGen = ++this._gen;
        const synthesisVoiceId = engine === "browser" ? (this.config.get("language") || "en-US") : voiceId;
        let audio;
        try {
            audio = await synthesize(engine, sampleText, synthesisVoiceId, apiKey);
        } catch (providerError) {
            if (engine === "browser") throw providerError;
            console.warn(`[AirCVoice] ${engine} preview unavailable; using device voice.`, providerError);
            audio = await synthesize("browser", sampleText, this.config.get("language") || "en-US");
        }
        this._bindAndPlay(audio, myGen);
    }
}

export { BUILT_IN_VOICES, ENGINE_INFO };
