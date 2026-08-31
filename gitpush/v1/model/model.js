// model/model.js
// AirC Model Module
// Owns the avatar (Rive character), its container, and its visual states.
// Does NOT know about AI responses, API keys, or speech recognition.
//
// Public interface is intentionally kept stable (mount / setState / getState)
// plus a few additive methods (setEmotion / attachAudioElement / triggerNod /
// destroy) so this module stays swappable — nothing outside this file talks
// to the Rive API directly.
//
// IMPORTANT: Rive is loaded via a DYNAMIC import (not a top-level static
// import). A static `import { Rive } from "..."` at the top of this file
// would mean that if the CDN request fails for any reason (offline, blocked,
// slow network, wrong URL), the ENTIRE module fails to load — which breaks
// every other button/handler in the app that imports this file, not just
// the avatar. Loading it dynamically inside a try/catch means a Rive/CDN
// failure only ever degrades the avatar to its CSS-only fallback and never
// takes the rest of the app down with it.

const VALID_STATES = ["idle", "listening", "thinking", "speaking"];
const STATE_MACHINE_NAME = "State Machine 1";
const RIVE_SRC = "./assets/clia.riv";
const RIVE_CDN_URL = "https://cdn.jsdelivr.net/npm/@rive-app/canvas@2.7.0/+esm";

// Names we look for inside the state machine. Kept in one place so a rename
// inside the .riv file only needs a one-line change here.
const INPUT_NAMES = {
    viseme: "viseme",
    nod: "Nod",
    happy: "Happy",
    sad: "Sad",
    joy: "Joy",
    eyeWidth: "eye_width",
    eyeHeight: "eye_height",
    listening: "Listening",
    thinking: "Thinking",
    idle: "Idle"
};

function normalizeName(name) {
    return String(name || "").trim().toLowerCase();
}

export class AirCModel {
    /**
     * @param {HTMLElement} container - element that will host the avatar.
     */
    constructor(container) {
        this.container = container;
        this.state = "idle";
        this.emotion = "neutral";

        this._wrapper = null;
        this._canvas = null;

        this._riveInstance = null;
        this._riveReady = false;
        this._riveFailed = false;
        this._inputs = {}; // resolved state-machine inputs, keyed by INPUT_NAMES keys
        this._warnedMissing = new Set(); // avoid spamming console for the same missing input

        this._blinkTimer = null;
        this._lastEmotionFired = null;

        // Audio-driven lip-sync
        this._audioCtx = null;
        this._analyser = null;
        this._sourceNode = null;
        this._rafId = null;
        this._attachedAudioEl = null;

        // Procedural fallback lip-sync (used for browser TTS, which exposes
        // no audio buffer we can analyse)
        this._fallbackRafId = null;
        this._fallbackActive = false;

        // Optional callback the app controller can hook into to surface
        // load failures on-screen (useful on mobile where console access is
        // inconvenient) — e.g. `model.onError = (msg) => showToast(msg);`
        this.onError = null;
    }

    mount() {
        this.container.innerHTML = "";

        const wrapper = document.createElement("div");
        wrapper.className = "airc-model-wrapper airc-state-idle";

        const glow = document.createElement("div");
        glow.className = "airc-model-glow";
        wrapper.appendChild(glow);

        const frameHolder = document.createElement("div");
        frameHolder.className = "airc-model-frame-holder";

        const canvas = document.createElement("canvas");
        canvas.className = "airc-model-canvas";
        canvas.style.width = "100%";
        canvas.style.height = "100%";
        canvas.style.display = "block";
        // The avatar must stay perfectly still — no drag/orbit input.
        canvas.style.pointerEvents = "none";
        // Give the canvas real pixel dimensions so Rive doesn't render blurry.
        const rect = frameHolder.getBoundingClientRect();
        canvas.width = Math.max(1, Math.floor((rect.width || this.container.clientWidth || 400) * (window.devicePixelRatio || 1)));
        canvas.height = Math.max(1, Math.floor((rect.height || this.container.clientHeight || 400) * (window.devicePixelRatio || 1)));

        frameHolder.appendChild(canvas);
        wrapper.appendChild(frameHolder);
        this.container.appendChild(wrapper);

        this._wrapper = wrapper;
        this._canvas = canvas;

        this._initRive().catch((err) => {
            // Extra safety net — should already be handled inside _initRive,
            // but never let a stray rejection surface as an unhandled error.
            this._onRiveLoadError(err);
        });
        this._handleResize = () => this._resizeCanvas();
        window.addEventListener("resize", this._handleResize);

        return this;
    }

    async _initRive() {
        let Rive;
        try {
            const mod = await import(RIVE_CDN_URL);
            Rive = mod.Rive;
            if (!Rive) throw new Error("Rive export not found on loaded module.");
        } catch (err) {
            this._onRiveLoadError(err);
            return;
        }

        try {
            this._riveInstance = new Rive({
                src: RIVE_SRC,
                canvas: this._canvas,
                autoplay: true,
                stateMachines: STATE_MACHINE_NAME,
                onLoad: () => this._onRiveLoad(),
                onLoadError: (err) => this._onRiveLoadError(err)
            });
        } catch (err) {
            this._onRiveLoadError(err);
        }
    }

    _onRiveLoad() {
        try {
            this._riveInstance.resizeDrawingSurfaceToCanvas();

            const rawInputs = this._riveInstance.stateMachineInputs(STATE_MACHINE_NAME) || [];

            // Log everything we found so exact input names/types can be
            // confirmed against the .riv file before relying on them.
            console.log(
                "[AirCModel] Rive state machine inputs:",
                rawInputs.map((i) => ({ name: i.name, type: this._describeInputType(i) }))
            );

            const byName = new Map(rawInputs.map((i) => [normalizeName(i.name), i]));

            Object.entries(INPUT_NAMES).forEach(([key, wantedName]) => {
                const found = byName.get(normalizeName(wantedName));
                this._inputs[key] = found || null;
                if (!found) this._warnMissing(wantedName);
            });

            this._riveReady = true;
            this._riveFailed = false;

            // Apply whatever state/emotion was requested before load finished.
            this._applyStateToRive(this.state);
            this._applyEmotionToRive(this.emotion, true);
        } catch (err) {
            console.warn("[AirCModel] Error reading Rive state machine inputs.", err);
        }
    }

    _onRiveLoadError(err) {
        this._riveFailed = true;
        this._riveReady = false;
        console.warn(
            "[AirCModel] clia.riv or the Rive runtime failed to load — falling back to CSS-only avatar (glow/breathing effects still active). The rest of the app is unaffected.",
            err
        );
        if (typeof this.onError === "function") {
            this.onError("Character couldn't load — check that assets/clia.riv is deployed and reachable.");
        }
        // Wrapper keeps its airc-state-* class regardless, so the existing
        // glow/breathing CSS keeps working with no canvas content.
    }

    _describeInputType(input) {
        // Rive's runtime exposes a numeric `type` plus boolean-ish helpers
        // depending on version; report defensively rather than assuming one API shape.
        if (typeof input.value === "boolean") return "boolean";
        if (typeof input.fire === "function" && typeof input.value === "undefined") return "trigger";
        if (typeof input.value === "number") return "number";
        return "unknown";
    }

    _warnMissing(name) {
        if (this._warnedMissing.has(name)) return;
        this._warnedMissing.add(name);
        console.warn(`[AirCModel] Missing Rive input: "${name}" — skipping, will not drive it.`);
    }

    _safeSetValue(input, value) {
        if (!input) return;
        try {
            input.value = value;
        } catch (err) {
            console.warn(`[AirCModel] Failed to set Rive input value.`, err);
        }
    }

    _safeFire(input) {
        if (!input) return;
        try {
            if (typeof input.fire === "function") input.fire();
        } catch (err) {
            console.warn(`[AirCModel] Failed to fire Rive input.`, err);
        }
    }

    _resizeCanvas() {
        if (!this._canvas || !this._riveInstance) return;
        try {
            const rect = this._canvas.parentElement.getBoundingClientRect();
            this._canvas.width = Math.max(1, Math.floor(rect.width * (window.devicePixelRatio || 1)));
            this._canvas.height = Math.max(1, Math.floor(rect.height * (window.devicePixelRatio || 1)));
            this._riveInstance.resizeDrawingSurfaceToCanvas();
        } catch (err) {
            // ignore resize errors, non-critical
        }
    }

    // -----------------------------------------------------------------
    // State
    // -----------------------------------------------------------------

    setState(state) {
        if (!VALID_STATES.includes(state)) {
            console.warn(`[AirCModel] Ignoring unknown state: ${state}`);
            return;
        }
        this.state = state;
        if (!this._wrapper) return;

        VALID_STATES.forEach((s) => this._wrapper.classList.remove(`airc-state-${s}`));
        this._wrapper.classList.add(`airc-state-${state}`);

        this._applyStateToRive(state);
    }

    _applyStateToRive(state) {
        if (!this._riveReady) return;

        if (state !== "speaking") {
            this._stopAudioLoop();
            this._stopFallbackLoop();
            this._safeSetValue(this._inputs.viseme, 0);
        }

        if (state === "idle") {
            this._safeSetValue(this._inputs.idle, true);
            this._startBlinkLoop(3000, 6000);
        } else if (state === "listening") {
            if (this._inputs.listening) {
                this._safeSetValue(this._inputs.listening, true);
            } else {
                this._safeSetValue(this._inputs.idle, true);
            }
            this._startBlinkLoop(1500, 3000);
        } else if (state === "thinking") {
            this._stopBlinkLoop();
            if (this._inputs.thinking) {
                // support both trigger-style and boolean-style "Thinking" inputs
                this._safeFire(this._inputs.thinking);
                this._safeSetValue(this._inputs.thinking, true);
            }
        } else if (state === "speaking") {
            this._stopBlinkLoop();
        }
    }

    // -----------------------------------------------------------------
    // Blinking (idle / listening only)
    // -----------------------------------------------------------------

    _startBlinkLoop(minMs, maxMs) {
        this._stopBlinkLoop();
        if (!this._inputs.eyeHeight) return; // nothing to drive, skip silently

        const schedule = () => {
            const delay = minMs + Math.random() * (maxMs - minMs);
            this._blinkTimer = setTimeout(() => {
                this._doBlink();
                schedule();
            }, delay);
        };
        schedule();
    }

    _stopBlinkLoop() {
        if (this._blinkTimer) {
            clearTimeout(this._blinkTimer);
            this._blinkTimer = null;
        }
    }

    _doBlink() {
        const input = this._inputs.eyeHeight;
        if (!input) return;
        const openValue = typeof input.value === "number" ? input.value : 1;
        this._safeSetValue(input, 0.05);
        setTimeout(() => this._safeSetValue(input, openValue || 1), 120);
    }

    // -----------------------------------------------------------------
    // Emotion
    // -----------------------------------------------------------------

    setEmotion(emotion) {
        this.emotion = emotion || "neutral";
        this._applyEmotionToRive(this.emotion, false);
    }

    _applyEmotionToRive(emotion, force) {
        if (!this._riveReady) return;
        if (!force && emotion === this._lastEmotionFired) return;

        const map = { happy: this._inputs.happy, sad: this._inputs.sad, joy: this._inputs.joy };
        const input = map[emotion];
        if (input) this._safeFire(input);
        this._lastEmotionFired = emotion;
    }

    // -----------------------------------------------------------------
    // Nod (acknowledgment gesture)
    // -----------------------------------------------------------------

    triggerNod() {
        if (!this._riveReady) return;
        this._safeFire(this._inputs.nod);
    }

    // -----------------------------------------------------------------
    // Lip-sync — live audio (ElevenLabs <audio> element)
    // -----------------------------------------------------------------

    attachAudioElement(audioEl) {
        this._stopFallbackLoop();

        if (!audioEl) {
            this._stopAudioLoop();
            this._safeSetValue(this._inputs.viseme, 0);
            // No real audio element (likely browser-TTS fallback) — use a
            // gentle procedural mouth-movement approximation instead.
            this._startFallbackLoop();
            return;
        }

        try {
            if (!this._audioCtx) {
                const Ctx = window.AudioContext || window.webkitAudioContext;
                this._audioCtx = new Ctx();
            }

            // Only create ONE MediaElementSource per <audio> element ever —
            // the Web Audio API throws if you call this twice on the same element.
            if (!audioEl._airc_hasMediaSource) {
                this._sourceNode = this._audioCtx.createMediaElementSource(audioEl);
                audioEl._airc_hasMediaSource = true;
                audioEl._airc_sourceNode = this._sourceNode;
            } else {
                this._sourceNode = audioEl._airc_sourceNode;
            }

            this._analyser = this._audioCtx.createAnalyser();
            this._analyser.fftSize = 256;

            this._sourceNode.connect(this._analyser);
            this._analyser.connect(this._audioCtx.destination); // keep audio audible

            this._attachedAudioEl = audioEl;

            const onEnded = () => this._stopAudioLoop();
            audioEl.addEventListener("ended", onEnded, { once: true });
            audioEl.addEventListener("pause", onEnded, { once: true });

            this._startAudioLoop();
        } catch (err) {
            console.warn("[AirCModel] Could not attach AnalyserNode to audio element, using fallback mouth movement.", err);
            this._startFallbackLoop();
        }
    }

    _startAudioLoop() {
        this._stopAudioLoop();
        if (!this._analyser) return;

        const data = new Uint8Array(this._analyser.frequencyBinCount);

        const tick = () => {
            if (this.state !== "speaking" || !this._analyser) {
                this._rafId = null;
                return;
            }
            this._analyser.getByteTimeDomainData(data);

            // Simple average deviation from the 128 (silence) midpoint,
            // normalized to ~0-1. Adjust range once real viseme min/max is
            // confirmed from the console-logged input info.
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += Math.abs(data[i] - 128);
            const avg = sum / data.length; // roughly 0-40 in practice
            const normalized = Math.min(1, avg / 40);

            this._safeSetValue(this._inputs.viseme, normalized);
            this._rafId = requestAnimationFrame(tick);
        };

        this._rafId = requestAnimationFrame(tick);
    }

    _stopAudioLoop() {
        if (this._rafId) {
            cancelAnimationFrame(this._rafId);
            this._rafId = null;
        }
        this._attachedAudioEl = null;
        this._safeSetValue(this._inputs.viseme, 0);
    }

    // -----------------------------------------------------------------
    // Lip-sync — procedural fallback (browser SpeechSynthesis, no buffer)
    // -----------------------------------------------------------------

    _startFallbackLoop() {
        this._stopFallbackLoop();
        if (!this._inputs.viseme) return;
        this._fallbackActive = true;

        const start = performance.now();
        const tick = (now) => {
            if (!this._fallbackActive || this.state !== "speaking") {
                this._fallbackRafId = null;
                return;
            }
            const t = (now - start) / 1000;
            // Gentle sine oscillation between 0 and ~0.4, purely a visual
            // approximation since browser TTS gives us no real amplitude.
            const value = Math.max(0, Math.sin(t * 8)) * 0.4;
            this._safeSetValue(this._inputs.viseme, value);
            this._fallbackRafId = requestAnimationFrame(tick);
        };
        this._fallbackRafId = requestAnimationFrame(tick);
    }

    _stopFallbackLoop() {
        this._fallbackActive = false;
        if (this._fallbackRafId) {
            cancelAnimationFrame(this._fallbackRafId);
            this._fallbackRafId = null;
        }
    }

    // -----------------------------------------------------------------

    getState() {
        return this.state;
    }

    destroy() {
        this._stopBlinkLoop();
        this._stopAudioLoop();
        this._stopFallbackLoop();

        if (this._handleResize) window.removeEventListener("resize", this._handleResize);

        try {
            this._riveInstance?.cleanup();
        } catch (err) {
            // ignore
        }

        if (this._audioCtx) {
            try {
                this._audioCtx.close();
            } catch (err) {
                // ignore
            }
            this._audioCtx = null;
        }
    }
}
