// config/config.js
// AirC Configuration Module
// Owns ALL persistent settings. Nothing else in the app should touch localStorage directly.

const STORAGE_KEY = "airc_config_v1";
const HISTORY_KEY = "airc_history_v1";
const SESSIONS_KEY = "airc_sessions_v1";
const VOICES_KEY = "airc_voices_v1";
const HISTORY_LIMIT = 50;
const SESSION_LIMIT = 40;

// Built-in ElevenLabs voice presets.
export const LANGUAGES = [
    { code: "hi-IN", label: "Hindi" },
    { code: "bn-IN", label: "Bengali" },
    { code: "en-US", label: "English" }
];

export function languageLabel(code) {
    const found = LANGUAGES.find((l) => l.code === code);
    return found ? found.label : "Hindi";
}

export const BUILT_IN_VOICES = [
    {
        id: "EXAVITQu4vr4xnSDxMaL",
        name: "Sarah",
        description: "Warm, soft and grounded. Great for long conversations.",
        builtIn: true
    },
    {
        id: "XrExE9yKIg1WjnnlVkGX",
        name: "Matilda",
        description: "Bright and playful with a quick, witty delivery.",
        builtIn: true
    },
    {
        id: "Xb7hH8MSUJpSbSDYk0k2",
        name: "Alice",
        description: "Clear and composed. Calm, confident presence.",
        builtIn: true
    }
];

const DEFAULTS = {
    openrouter_api_key: "",
    openrouter_model: "openai/gpt-4o-mini",
    elevenlabs_api_key: "",
    elevenlabs_voice_id: "",
    selected_voice: "", // name of the selected voice, for display
    language: "hi-IN",
    persona: "balanced", // friendly | balanced | savage
    show_captions: false,
    roast_intensity: "normal", // mild | normal | savage
    onboarding_complete: false,
    microphone_setup_complete: false,
    voice_setup_complete: false
};

// persona <-> roast intensity stay in sync so old logic keeps working.
const PERSONA_TO_ROAST = { friendly: "mild", balanced: "normal", savage: "savage" };
const ROAST_TO_PERSONA = { mild: "friendly", normal: "balanced", savage: "savage" };

export class AirCConfig {
    constructor() {
        this._data = { ...DEFAULTS, ...this._load() };
        // Keep persona / roast_intensity consistent on boot.
        if (PERSONA_TO_ROAST[this._data.persona]) {
            this._data.roast_intensity = PERSONA_TO_ROAST[this._data.persona];
        } else if (ROAST_TO_PERSONA[this._data.roast_intensity]) {
            this._data.persona = ROAST_TO_PERSONA[this._data.roast_intensity];
        }
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
        if (key === "persona" && PERSONA_TO_ROAST[value]) {
            this._data.roast_intensity = PERSONA_TO_ROAST[value];
        }
        if (key === "roast_intensity" && ROAST_TO_PERSONA[value]) {
            this._data.persona = ROAST_TO_PERSONA[value];
        }
        return this._data[key];
    }

    setMany(obj) {
        Object.keys(obj).forEach((k) => this.set(k, obj[k]));
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
        return Boolean(
            this._data.openrouter_api_key &&
            this._data.openrouter_model &&
            this._data.elevenlabs_api_key &&
            this._data.elevenlabs_voice_id
        );
    }

    hasVoiceSelected() {
        return Boolean(this._data.voice_setup_complete && this._data.selected_voice);
    }

    // ---------------------------------------------------------------------
    // Voice library (built-ins + user-added ElevenLabs voice IDs)
    // ---------------------------------------------------------------------

    getVoices() {
        return [...BUILT_IN_VOICES, ...this.getCustomVoices()];
    }

    getCustomVoices() {
        try {
            const raw = localStorage.getItem(VOICES_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            return [];
        }
    }

    addCustomVoice({ id, name, description }) {
        if (!id || !id.trim()) return null;
        const voiceId = id.trim();
        const list = this.getCustomVoices();
        const existing = list.find((v) => v.id === voiceId);
        if (existing) return existing;
        const entry = {
            id: voiceId,
            name: (name && name.trim()) || `Voice ${voiceId.slice(0, 6)}`,
            description: (description && description.trim()) || "Your custom ElevenLabs voice.",
            builtIn: false
        };
        list.push(entry);
        try {
            localStorage.setItem(VOICES_KEY, JSON.stringify(list));
        } catch (err) {
            console.warn("[AirCConfig] Failed to store custom voice.", err);
        }
        return entry;
    }

    removeCustomVoice(id) {
        const list = this.getCustomVoices().filter((v) => v.id !== id);
        try {
            localStorage.setItem(VOICES_KEY, JSON.stringify(list));
        } catch (err) {
            /* ignore */
        }
    }

    // ---------------------------------------------------------------------
    // Conversation sessions (chat history drawer)
    // ---------------------------------------------------------------------

    getSessions() {
        try {
            const raw = localStorage.getItem(SESSIONS_KEY);
            const parsed = raw ? JSON.parse(raw) : [];
            return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
            return [];
        }
    }

    _saveSessions(list) {
        try {
            localStorage.setItem(SESSIONS_KEY, JSON.stringify(list.slice(0, SESSION_LIMIT)));
        } catch (err) {
            console.warn("[AirCConfig] Failed to save sessions.", err);
        }
    }

    createSession(title) {
        const session = {
            id: `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            title: title || "New conversation",
            ts: Date.now(),
            messages: []
        };
        const list = this.getSessions();
        list.unshift(session);
        this._saveSessions(list);
        return session;
    }

    getSession(id) {
        return this.getSessions().find((s) => s.id === id) || null;
    }

    appendMessage(sessionId, role, content) {
        if (!sessionId || !content) return;
        const list = this.getSessions();
        const session = list.find((s) => s.id === sessionId);
        if (!session) return;
        session.messages.push({ role, content, ts: Date.now() });
        session.ts = Date.now();
        if (session.title === "New conversation" && role === "user") {
            session.title = content.slice(0, 42);
        }
        // move to top
        this._saveSessions([session, ...list.filter((s) => s.id !== sessionId)]);
    }

    deleteSession(id) {
        this._saveSessions(this.getSessions().filter((s) => s.id !== id));
    }

    clearSessions() {
        try {
            localStorage.removeItem(SESSIONS_KEY);
        } catch (err) {
            /* ignore */
        }
    }

    // ---------------------------------------------------------------------
    // Legacy flat utterance history (kept for backwards compatibility).
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
