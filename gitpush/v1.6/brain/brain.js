// brain/brain.js
// AirC Brain Module
// Owns: OpenRouter API calls, system prompt / personality, conversation history,
// response classification, roast/follow-up/encouragement/supportive behavior,
// and silence handling. Does NOT touch mic UI, Sketchfab, audio playback, or settings UI.

import { languageLabel } from "../config/config.js";

const MAX_HISTORY_TURNS = 14; // ~10-15 recent turns, in-memory only (session, not persisted)

const ROAST_LINES = {
    mild: {
        silence: [
            "Took you a sec there — everything okay, or just thinking real hard?",
            "Quiet moment. I'll allow it, but let's keep going.",
            "You went silent on me. I see you."
        ],
        lowEffort: [
            "That's it? Give me a little more than that.",
            "One word? C'mon, you can do better.",
            "Okay, brief. Wanna expand on that a bit?"
        ]
    },
    normal: {
        silence: [
            "Ten seconds of silence? I asked you a question, not for a dramatic pause.",
            "You're just staring at me now, huh. I can wait, but I'm judging a little.",
            "Buffering? Take your time... actually, don't, I'm nosy."
        ],
        lowEffort: [
            "'Yeah' is not a sentence. Try again.",
            "Wow, riveting. Give me something to work with here.",
            "One-word answers are giving 'interrogation room,' not 'conversation.'"
        ]
    },
    savage: {
        silence: [
            "That silence was so loud I almost put on a podcast.",
            "You disappeared harder than my faith in small talk. Come back.",
            "I've had more engaging conversations with a loading screen."
        ],
        lowEffort: [
            "That answer had less effort than a group project slide.",
            "'K.' Incredible. Truly a TED talk.",
            "I've seen more personality in a captcha. Try again."
        ]
    }
};

const SUPPORTIVE_LINES = [
    "Hey, you good? We can pause if you want.",
    "No pressure at all — I'm here whenever you're ready.",
    "We can just sit for a sec if today's a lot. I'm not going anywhere."
];

function buildSystemPrompt(roastIntensity, languageLabel) {
    return `You are AirC, a voice-first AI companion with a female personality. You are having a live spoken conversation, not typing in a chat window.

Personality: witty, confident, playful, a little sarcastic, sometimes savage (intensity: ${roastIntensity}), warm when it actually matters, conversational and natural — like a clever, quick-witted friend on a video call, never like a corporate assistant.

Hard rules:
- Never say "As an AI..." or use generic assistant phrasing.
- No long explanations or lecture-y answers. Keep replies short — 1-3 sentences, like real speech.
- Use contractions, natural reactions, and follow-up questions.
- Light teasing is welcome. Roasting only ever targets BEHAVIOR (silence, one-word answers, laziness, avoiding the question, low effort, excuses) — NEVER appearance, body, intelligence, race, religion, gender, identity, family, disability, or any personal insecurity. No slurs, no genuinely abusive language, ever.
- If the user seems distressed, upset, or repeatedly disengaged, drop the teasing entirely and be warm and supportive instead.
- Respond only with what AirC would actually say out loud — no stage directions, no asterisks, no emoji.
- Respond in ${languageLabel} (script + tone natural for a spoken voice reply), regardless of the language the transcript arrives in, unless the user explicitly switches.`;
}

export class AirCBrain {
    /**
     * @param {AirCConfig} config
     */
    constructor(config) {
        this.config = config;
        this.history = []; // { role: "user"|"assistant", content: string }
        this.consecutiveSilences = 0;
        this.consecutiveLowEffort = 0;
    }

    resetSession() {
        this.history = [];
        this.consecutiveSilences = 0;
        this.consecutiveLowEffort = 0;
    }

    /**
     * Change the active persona. Roast intensity is derived from it inside
     * AirCConfig, so the existing roast logic keeps working unchanged.
     */
    setPersona(persona) {
        this.config.set("persona", persona);
        this.config.save();
        return this.config.get("persona");
    }

    getPersona() {
        return this.config.get("persona") || "balanced";
    }

    /**
     * Rehydrate the in-memory conversation from a stored session so an old
     * conversation can be continued with context.
     */
    loadHistory(messages) {
        this.history = (messages || [])
            .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content)
            .map((m) => ({ role: m.role, content: m.content }));
        this.consecutiveSilences = 0;
        this.consecutiveLowEffort = 0;
    }


    _pushHistory(role, content) {
        this.history.push({ role, content });
        const maxMessages = MAX_HISTORY_TURNS * 2;
        if (this.history.length > maxMessages) {
            this.history = this.history.slice(this.history.length - maxMessages);
        }
    }

    _isLowEffort(text) {
        const trimmed = text.trim();
        if (!trimmed) return true;
        const wordCount = trimmed.split(/\s+/).length;
        if (wordCount <= 1) return true;
        const lowEffortSet = new Set([
            "ok", "okay", "k", "yeah", "yep", "no", "nah", "sure", "fine",
            "idk", "whatever", "meh", "yes"
        ]);
        return wordCount <= 2 && lowEffortSet.has(trimmed.toLowerCase().replace(/[.!?]/g, ""));
    }

    _pickLine(list) {
        return list[Math.floor(Math.random() * list.length)];
    }

    _roastIntensity() {
        const val = this.config.get("roast_intensity");
        return ROAST_LINES[val] ? val : "normal";
    }

    /**
     * First line AirC speaks when the app opens. AirC always speaks first.
     */
    async openingLine() {
        const openers = [
            "Hey! There you are — I was starting to think I'd been talking to myself.",
            "Hi. Okay, I'm listening — what's going on with you today?",
            "There you are. So, what are we getting into today?"
        ];
        const text = this._pickLine(openers);
        this._pushHistory("assistant", text);
        return { type: "normal", text };
    }

    /**
     * Generate a normal response to user speech.
     * @param {string} userText
     */
    async respond(userText) {
        if (this._isLowEffort(userText)) {
            this.consecutiveLowEffort += 1;
        } else {
            this.consecutiveLowEffort = 0;
        }
        this.consecutiveSilences = 0; // user spoke, silence streak resets

        this._pushHistory("user", userText);

        if (this.consecutiveLowEffort >= 2) {
            const intensity = this._roastIntensity();
            const text = this._pickLine(ROAST_LINES[intensity].lowEffort);
            this._pushHistory("assistant", text);
            return { type: "roast", text };
        }

        try {
            const text = await this._generate();
            this._pushHistory("assistant", text);
            return { type: "normal", text };
        } catch (err) {
            console.error("[AirCBrain] Generation failed.", err);
            const fallback = "Internet's being dramatic. Give me a second.";
            this._pushHistory("assistant", fallback);
            return { type: "fallback", text: fallback, error: err };
        }
    }

    /**
     * Called when the silence timer elapses with no user speech.
     */
    async handleSilence() {
        this.consecutiveSilences += 1;
        this.consecutiveLowEffort = 0;

        if (this.consecutiveSilences >= 2) {
            const text = this._pickLine(SUPPORTIVE_LINES);
            this._pushHistory("assistant", text);
            return { type: "supportive", text };
        }

        const intensity = this._roastIntensity();
        const text = this._pickLine(ROAST_LINES[intensity].silence);
        this._pushHistory("assistant", text);
        return { type: "roast", text };
    }

    async _generate() {
        const apiKey = this.config.get("openrouter_api_key");
        const model = this.config.get("openrouter_model");
        if (!apiKey || !model) {
            throw new Error("OpenRouter is not configured.");
        }

        const messages = [
            { role: "system", content: buildSystemPrompt(this._roastIntensity(), languageLabel(this.config.get("language"))) },
            ...this.history
        ];

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.9,
                max_tokens: 180
            })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => "");
            throw new Error(`OpenRouter error ${response.status}: ${errText}`);
        }

        const data = await response.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (!text) throw new Error("Empty response from OpenRouter.");
        return text;
    }
}
