// model/model.js
// AirC Model Module
// Owns the avatar (two pre-rendered looping video clips), its container,
// and its visual states.
// Does NOT know about AI responses, API keys, or speech recognition.
//
// Public interface is intentionally kept stable (mount / setState / getState)
// plus a few additive methods (setEmotion / attachAudioElement / triggerNod /
// destroy) so this module stays swappable — nothing outside this file needs
// to change when the avatar's internals change.
//
// The avatar is now driven by two <video> elements instead of a Rive canvas:
//   - an "idle" clip, used for idle / listening / thinking (merged into one
//     loop since none of those three need a visually distinct animation), and
//   - a "speaking" clip, used only while the model is in the "speaking" state.
// Only one video is ever visible/playing at a time; setState() swaps them.

const VALID_STATES = ["idle", "listening", "thinking", "speaking"];

const VIDEO_SRC = {
    idle: "./assets/clia-idle.mp4",
    speaking: "./assets/clia-speaking.mp4"
};

export class AirCModel {
    /**
     * @param {HTMLElement} container - element that will host the avatar.
     */
    constructor(container) {
        this.container = container;
        this.state = "idle";
        this.emotion = "neutral";

        this._wrapper = null;
        this._videoIdle = null;
        this._videoSpeaking = null;

        // Tracks whatever <audio> element attachAudioElement() last attached
        // listeners to, so they can be cleaned up before attaching new ones
        // (or on destroy) instead of piling up.
        this._attachedAudioEl = null;
        this._audioEndedHandler = null;
        this._audioPauseHandler = null;

        // Optional callback the app controller can hook into to surface
        // load failures on-screen — e.g. `model.onError = (msg) => showToast(msg);`.
        // Kept as a no-op hook (never called internally now that there's no
        // CDN/asset load to fail) purely so external assignments/calls never throw.
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

        const videoIdle = this._createVideo("clia-idle", VIDEO_SRC.idle);
        const videoSpeaking = this._createVideo("clia-speaking", VIDEO_SRC.speaking);

        // Idle clip visible by default (matches the initial "idle" state);
        // speaking clip stays hidden until we actually enter "speaking".
        videoIdle.style.display = "block";
        videoSpeaking.style.display = "none";

        frameHolder.appendChild(videoIdle);
        frameHolder.appendChild(videoSpeaking);
        wrapper.appendChild(frameHolder);
        this.container.appendChild(wrapper);

        this._wrapper = wrapper;
        this._videoIdle = videoIdle;
        this._videoSpeaking = videoSpeaking;

        this._safePlay(this._videoIdle);

        return this;
    }

    _createVideo(id, src) {
        const video = document.createElement("video");
        video.id = id;
        video.className = "airc-model-video";
        video.src = src;
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        video.playsInline = true;
        video.setAttribute("playsinline", ""); // iOS Safari wants the attribute too
        video.style.position = "absolute";
        video.style.top = "0";
        video.style.left = "0";
        video.style.width = "100%";
        video.style.height = "100%";
        video.style.objectFit = "cover";
        // The avatar must stay perfectly still — no drag/orbit/tap input.
        video.style.pointerEvents = "none";
        return video;
    }

    _safePlay(video) {
        if (!video) return;
        const playPromise = video.play();
        // play() can reject (e.g. autoplay policy edge cases) — never let
        // that surface as an unhandled rejection.
        if (playPromise && typeof playPromise.catch === "function") {
            playPromise.catch(() => {});
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

        this._applyStateToVideo(state);
    }

    _applyStateToVideo(state) {
        if (!this._videoIdle || !this._videoSpeaking) return;

        if (state === "speaking") {
            this._videoIdle.style.display = "none";
            this._videoSpeaking.style.display = "block";
            // Only restart from the beginning when we're freshly entering
            // "speaking" — if we're already speaking (e.g. redundant
            // setState calls), let playback continue smoothly.
            if (this._videoSpeaking.paused || this._videoSpeaking.ended) {
                try {
                    this._videoSpeaking.currentTime = 0;
                } catch (err) {
                    // ignore — currentTime can throw before metadata is loaded
                }
            }
            this._safePlay(this._videoSpeaking);
        } else {
            // "idle", "listening", and "thinking" all share the idle clip.
            this._videoSpeaking.style.display = "none";
            this._videoSpeaking.pause();

            this._videoIdle.style.display = "block";
            if (this._videoIdle.paused) this._safePlay(this._videoIdle);
        }
    }

    // -----------------------------------------------------------------
    // Emotion / gesture — no-ops for now (no per-emotion or nod video
    // variants exist yet). Kept so existing callers don't break.
    // -----------------------------------------------------------------

    setEmotion(emotion) {
        this.emotion = emotion || "neutral";
    }

    triggerNod() {
        // no-op — no nod animation variant to trigger yet.
    }

    // -----------------------------------------------------------------
    // Speaking-state binding to a TTS <audio> element
    // -----------------------------------------------------------------

    /**
     * Keeps state "speaking" while the given audio element plays, and
     * returns to "idle" once it ends or is paused. No analyser/viseme
     * logic is needed anymore since lip-sync is baked into the video.
     */
    attachAudioElement(audioEl) {
        this._detachAudioElement();

        if (!audioEl) {
            // No real audio element (e.g. browser-TTS fallback with no
            // accessible buffer) — nothing to bind to, just keep whatever
            // state the caller has already set.
            return;
        }

        this._attachedAudioEl = audioEl;

        const onEnded = () => this.setState("idle");
        this._audioEndedHandler = onEnded;
        this._audioPauseHandler = onEnded;

        audioEl.addEventListener("ended", onEnded, { once: true });
        audioEl.addEventListener("pause", onEnded, { once: true });

        this.setState("speaking");
    }

    _detachAudioElement() {
        if (this._attachedAudioEl) {
            if (this._audioEndedHandler) {
                this._attachedAudioEl.removeEventListener("ended", this._audioEndedHandler);
            }
            if (this._audioPauseHandler) {
                this._attachedAudioEl.removeEventListener("pause", this._audioPauseHandler);
            }
        }
        this._attachedAudioEl = null;
        this._audioEndedHandler = null;
        this._audioPauseHandler = null;
    }

    // -----------------------------------------------------------------

    getState() {
        return this.state;
    }

    destroy() {
        this._detachAudioElement();

        if (this._videoIdle) {
            this._videoIdle.pause();
            this._videoIdle.src = "";
        }
        if (this._videoSpeaking) {
            this._videoSpeaking.pause();
            this._videoSpeaking.src = "";
        }
    }
}
