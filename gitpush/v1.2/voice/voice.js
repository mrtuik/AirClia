// voice/voice.js
// AirC Voice Module
// Owns all speech OUTPUT: ElevenLabs API, audio playback, instant interruption,
// and browser SpeechSynthesis fallback. Does NOT decide what AirC says.

export class AirCVoice {
    /**
     * @param {AirCConfig} config
     */
    constructor(config) {
        this.config = config;
        this._audio = null;
        this._currentObjectUrl = null;
        this._speaking = false;
        this._utterance = null;

        // Optional callbacks the app controller can hook into.
        this.onStart = null;
        this.onEnd = null;
        this.onError = null;
    }

    isSpeaking() {
        return this._speaking;
    }

    /**
     * Returns the currently-playing <audio> element (ElevenLabs path), or
     * null if nothing is playing or we're using the browser TTS fallback.
     * Browser SpeechSynthesis has no accessible audio buffer, so real
     * amplitude-based lip-sync isn't possible in that path — the caller
     * (AirCModel) falls back to a procedural mouth-movement approximation
     * when this returns null.
     */
    getAudioElement() {
        return this._audio;
    }

    /**
     * Speak the given text. Tries ElevenLabs first, falls back to the
     * browser's SpeechSynthesis if ElevenLabs is unavailable or fails.
     * @param {string} text
     */
    async speak(text) {
        if (!text || !text.trim()) return;

        // Always fully stop whatever is currently playing before starting new speech.
        this.stop();

        const apiKey = this.config.get("elevenlabs_api_key");
        const voiceId = this.config.get("elevenlabs_voice_id");

        if (apiKey && voiceId) {
            try {
                await this._speakWithElevenLabs(text, apiKey, voiceId);
                return;
            } catch (err) {
                console.warn("[AirCVoice] ElevenLabs failed, falling back to browser TTS.", err);
                if (this.onError) this.onError("elevenlabs", err);
            }
        }

        this._speakWithBrowserTTS(text);
    }

    async _speakWithElevenLabs(text, apiKey, voiceId) {
        const response = await fetch(
            `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "xi-api-key": apiKey
                },
                body: JSON.stringify({
                    text,
                    model_id: "eleven_multilingual_v2",
                    voice_settings: {
                        stability: 0.45,
                        similarity_boost: 0.8
                    }
                })
            }
        );

        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`ElevenLabs error ${response.status}: ${errText}`);
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        this._currentObjectUrl = url;

        const audio = new Audio(url);
        this._audio = audio;
        this._speaking = true;

        audio.addEventListener("play", () => {
            if (this.onStart) this.onStart();
        });
        audio.addEventListener("ended", () => {
            this._speaking = false;
            this._cleanupObjectUrl();
            if (this.onEnd) this.onEnd();
        });
        audio.addEventListener("error", (e) => {
            this._speaking = false;
            this._cleanupObjectUrl();
            if (this.onError) this.onError("audio", e);
            if (this.onEnd) this.onEnd();
        });

        await audio.play();
    }

    _speakWithBrowserTTS(text) {
        if (!("speechSynthesis" in window)) {
            console.error("[AirCVoice] No TTS available on this browser.");
            if (this.onError) this.onError("no-tts", new Error("SpeechSynthesis unsupported"));
            if (this.onEnd) this.onEnd();
            return;
        }

        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 1.02;
        utterance.pitch = 1.05;

        utterance.onstart = () => {
            this._speaking = true;
            if (this.onStart) this.onStart();
        };
        utterance.onend = () => {
            this._speaking = false;
            this._utterance = null;
            if (this.onEnd) this.onEnd();
        };
        utterance.onerror = (e) => {
            this._speaking = false;
            this._utterance = null;
            if (this.onError) this.onError("speech-synthesis", e);
            if (this.onEnd) this.onEnd();
        };

        this._utterance = utterance;
        window.speechSynthesis.speak(utterance);
    }

    /**
     * Immediately stop any speech in progress. Must be fast — this is what
     * makes the interrupt system feel instant.
     */
    stop() {
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

        if ("speechSynthesis" in window && window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
        }
        this._utterance = null;
        this._speaking = false;
    }

    _cleanupObjectUrl() {
        if (this._currentObjectUrl) {
            URL.revokeObjectURL(this._currentObjectUrl);
            this._currentObjectUrl = null;
        }
    }

    /**
     * Test the currently configured ElevenLabs voice with a short line.
     * Throws on failure so the caller (Settings UI) can show a useful error.
     */
    async testVoice(sampleText = "Hey, this is what I sound like.") {
        const apiKey = this.config.get("elevenlabs_api_key");
        const voiceId = this.config.get("elevenlabs_voice_id");
        if (!apiKey || !voiceId) {
            throw new Error("Add your ElevenLabs API key and Voice ID first.");
        }
        await this._speakWithElevenLabs(sampleText, apiKey, voiceId);
    }
}
