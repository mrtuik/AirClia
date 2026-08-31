// config/config.js
// AirC Configuration Module
// Owns ALL persistent settings. Nothing else in the app should touch localStorage directly.

const STORAGE_KEY = "airc_config_v1";
const HISTORY_KEY = "airc_history_v1";
const HISTORY_LIMIT = 50;

const DEFAULTS = {
    openrouter_api_key: "",
    openrouter_model: "openai/gpt-4o-mini",
    elevenlabs_api_key: "",
    elevenlabs_voice_id: "",
    show_captions: false,
    roast_intensity: "normal" // mild | normal | savage
};

export class AirCConfig {
    constructor() {
        this._data = { ...DEFAULTS, ...this._load() };
    }

    _load() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return typeof parsed === "object" && parsed !== null ? parsed : {};
        } catch (err) {
            console.warn("[AirCConfig] Failed to load config, using defaults.", err);
            return {};
        }
    }

    get(key) {
        return this._data[key];
    }

    set(key, value) {
        this._data[key] = value;
        return this._data[key];
    }

    setMany(obj) {
        Object.assign(this._data, obj);
    }

    getAll() {
        return { ...this._data };
    }

    save() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._data));
            return true;
        } catch (err) {
            console.error("[AirCConfig] Failed to save config.", err);
            return false;
        }
    }

    reset() {
        this._data = { ...DEFAULTS };
        this.save();
    }

    // Returns true if the minimum required config is present to run the app.
    isComplete() {
        return Boolean(
            this._data.openrouter_api_key &&
            this._data.openrouter_model &&
            this._data.elevenlabs_api_key &&
            this._data.elevenlabs_voice_id
        );
    }

    // Returns true if voice output can at least fall back to browser TTS,
    // i.e. the brain can run even if ElevenLabs isn't configured.
    canRunWithFallback() {
        return Boolean(this._data.openrouter_api_key && this._data.openrouter_model);
    }

    // ---------------------------------------------------------------------
    // Conversation history (for the History screen). Stored under its own
    // key, independent of settings, and saved immediately on each entry —
    // it doesn't wait for the Settings "Save" button.
    // ---------------------------------------------------------------------

    addHistoryEntry(text) {
        if (!text || !text.trim()) return;
        const list = this.getHistory();
        list.unshift({ text: text.trim(), ts: Date.now() });
        try {
            localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_LIMIT)));
        } catch (err) {
            console.warn("[AirCConfig] Failed to save history entry.", err);
        }
    }

    getHistory() {
        try {
            const raw = localStorage.getItem(HISTORY_KEY);
            if (!raw) return [];
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            console.warn("[AirCConfig] Failed to load history.", err);
            return [];
        }
    }

    clearHistory() {
        try {
            localStorage.removeItem(HISTORY_KEY);
        } catch (err) {
            // ignore
        }
    }
}
