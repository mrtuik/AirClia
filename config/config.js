// config/config.js
// AirC Configuration Module
// Owns ALL persistent settings. Nothing else in the app should touch localStorage directly.

import { BUILT_IN_VOICES } from "../voice/engines.js";

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

// Used only when building the LLM system prompt (see brain/brain.js) — same
// language choice as languageLabel(), but spelled out so the model replies
// in plain Roman/English letters (Hinglish/Benglish) instead of switching
// into native Devanagari/Bengali script.
export function languageSpeakingInstruction(code) {
    if (code === "hi-IN") {
        return 'Hinglish — Hindi words, but spelled out in plain Roman/English letters only (e.g. "Main accha hun, tum kaise ho"), never Devanagari script';
    }
    if (code === "bn-IN") {
        return 'Benglish — Bengali words, but spelled out in plain Roman/English letters only (e.g. "Ami bhalo achi, tumi kemon acho"), never Bengali script';
    }
    return languageLabel(code);
}

const DEFAULTS = {
    openrouter_api_key: "",
    openrouter_model: "openai/gpt-4o-mini",
    elevenlabs_api_key: "",
    openai_api_key: "",
    tts_engine: "edge", // edge | google | elevenlabs | openai — defaults to a free, keyless engine
    voice_id: "",
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

    // Returns true if the assistant brain (LLM) is configured — this is
    // the only hard requirement to start using the app. Voice/TTS is
    // separate: the default engine (Microsoft Edge) is free and keyless,
    // so voice never has to gate app startup the way the brain does.
    isComplete() {
        return Boolean(this._data.openrouter_api_key && this._data.openrouter_model);
    }

    canRunWithFallback() {
        return Boolean(this._data.openrouter_api_key && this._data.openrouter_model);
    }

    hasVoiceSelected() {
        return Boolean(this._data.voice_setup_complete && this._data.selected_voice);
    }

    // ---------------------------------------------------------------------
    // Voice library — built-ins (from voice/engines.js) + user-added custom
    // voices, both scoped per TTS engine (ElevenLabs/OpenAI voice IDs are
    // account-specific; Edge/Google only ship curated built-ins).
    // ---------------------------------------------------------------------

    getVoices(engine) {
        const builtIns = (BUILT_IN_VOICES[engine] || []).map((v) => ({ ...v, builtIn: true }));
        return [...builtIns, ...this.getCustomVoices(engine)];
    }

    _allCustomVoices() {
        try {
            const raw = localStorage.getItem(VOICES_KEY);
            const parsed = raw ? JSON.parse(raw) : {};
            // Migrate the old flat array (ElevenLabs-only) into the new
            // per-engine shape the first time this runs.
            if (Array.isArray(parsed)) return { elevenlabs: parsed };
            return parsed && typeof parsed === "object" ? parsed : {};
        } catch (err) {
            return {};
        }
    }

    _saveAllCustomVoices(byEngine) {
        try {
            localStorage.setItem(VOICES_KEY, JSON.stringify(byEngine));
        } catch (err) {
            console.warn("[AirCConfig] Failed to store custom voice.", err);
        }
    }

    getCustomVoices(engine) {
        const all = this._allCustomVoices();
        const list = all[engine];
        return Array.isArray(list) ? list : [];
    }

    addCustomVoice(engine, { id, name, description }) {
        if (!id || !id.trim()) return null;
        const voiceId = id.trim();
        const all = this._allCustomVoices();
        const list = Array.isArray(all[engine]) ? all[engine] : [];
        const existing = list.find((v) => v.id === voiceId);
        if (existing) return existing;
        const entry = {
            id: voiceId,
            name: (name && name.trim()) || `Voice ${voiceId.slice(0, 6)}`,
            description: (description && description.trim()) || "Your custom voice.",
            builtIn: false
        };
        list.push(entry);
        all[engine] = list;
        this._saveAllCustomVoices(all);
        return entry;
    }

    removeCustomVoice(engine, id) {
        const all = this._allCustomVoices();
        all[engine] = (all[engine] || []).filter((v) => v.id !== id);
        this._saveAllCustomVoices(all);
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
