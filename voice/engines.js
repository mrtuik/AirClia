// voice/engines.js
// AirC TTS Engines
// Each engine exposes: synthesize(text, voiceId, apiKey) -> Promise<PlayableAudio>
// PlayableAudio is either a real <audio> element or a ChainedAudio facade —
// both support play()/pause()/currentTime and the "play"/"ended"/"error"
// events that voice.js and model.js rely on.
//
// IMPORTANT HONESTY NOTE (read before assuming any of these "just work"):
// - ElevenLabs and OpenAI are official, documented APIs. They work as long
//   as the API key + voice id are valid and there's quota left.
// - Microsoft Edge TTS and Google Translate TTS are UNOFFICIAL, reverse
//   engineered endpoints. They are free and keyless, but Microsoft/Google
//   can rate-limit, block, or change them at any time without notice —
//   that's the tradeoff for "free unlimited". If Edge TTS 403s, it is
//   almost always the server rejecting the request's Origin/handshake —
//   a pure static frontend cannot fully control that. A small serverless
//   proxy (Cloudflare Worker etc.) removes the 403 reliably; this file
//   makes a best-effort direct-from-browser attempt first.

export const ENGINE_INFO = {
    elevenlabs: { label: "ElevenLabs", needsKey: true, free: false },
    edge: { label: "Microsoft Edge", needsKey: false, free: true },
    google: { label: "Google Translate", needsKey: false, free: true },
    openai: { label: "OpenAI", needsKey: true, free: false }
};

export const ENGINE_ORDER = ["edge", "google", "elevenlabs", "openai"];

// ---------------------------------------------------------------------
// Built-in voice catalogs (curated — these unofficial APIs don't expose a
// simple public "list voices" call we can hit keylessly from a browser).
// ---------------------------------------------------------------------

export const BUILT_IN_VOICES = {
    elevenlabs: [
        { id: "EXAVITQu4vr4xnSDxMaL", name: "Sarah", description: "Warm, soft and grounded. Great for long conversations.", lang: "en-US" },
        { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", description: "Bright and playful with a quick, witty delivery.", lang: "en-US" },
        { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", description: "Clear and composed. Calm, confident presence.", lang: "en-US" }
    ],
    edge: [
        { id: "hi-IN-SwaraNeural", name: "Swara", description: "Hindi, female. Free Microsoft neural voice.", lang: "hi-IN" },
        { id: "hi-IN-MadhurNeural", name: "Madhur", description: "Hindi, male. Free Microsoft neural voice.", lang: "hi-IN" },
        { id: "bn-IN-TanishaaNeural", name: "Tanishaa", description: "Bengali, female. Free Microsoft neural voice.", lang: "bn-IN" },
        { id: "bn-IN-BashkarNeural", name: "Bashkar", description: "Bengali, male. Free Microsoft neural voice.", lang: "bn-IN" },
        { id: "en-US-AriaNeural", name: "Aria", description: "English, female. Free Microsoft neural voice.", lang: "en-US" },
        { id: "en-US-GuyNeural", name: "Guy", description: "English, male. Free Microsoft neural voice.", lang: "en-US" }
    ],
    google: [
        { id: "hi", name: "Google Hindi", description: "Free Google Translate voice (Hindi).", lang: "hi-IN" },
        { id: "bn", name: "Google Bengali", description: "Free Google Translate voice (Bengali).", lang: "bn-IN" },
        { id: "en", name: "Google English", description: "Free Google Translate voice (English).", lang: "en-US" }
    ],
    openai: [
        { id: "alloy", name: "Alloy", description: "Neutral and balanced.", lang: "" },
        { id: "nova", name: "Nova", description: "Warm and energetic.", lang: "" },
        { id: "shimmer", name: "Shimmer", description: "Soft and expressive.", lang: "" },
        { id: "echo", name: "Echo", description: "Confident, mid-register.", lang: "" },
        { id: "fable", name: "Fable", description: "Bright, storyteller tone.", lang: "" },
        { id: "onyx", name: "Onyx", description: "Deep and steady.", lang: "" }
    ]
};

// ---------------------------------------------------------------------
// A tiny EventTarget-based facade so multi-request engines (Google) can
// be handed back to voice.js/model.js exactly like a real <audio> element:
// play()/pause()/currentTime + "play"/"ended"/"error" events.
// ---------------------------------------------------------------------
class ChainedAudio extends EventTarget {
    constructor(urls) {
        super();
        this._urls = urls;
        this._idx = -1;
        this._audio = null;
        this._stopped = false;
    }

    _playNext() {
        if (this._stopped) return;
        this._idx++;
        if (this._idx >= this._urls.length) {
            this.dispatchEvent(new Event("ended"));
            return;
        }
        const a = new Audio(this._urls[this._idx]);
        this._audio = a;
        a.addEventListener("play", () => {
            if (this._idx === 0) this.dispatchEvent(new Event("play"));
        });
        a.addEventListener("ended", () => this._playNext());
        a.addEventListener("error", () => {
            this._stopped = true;
            this.dispatchEvent(new Event("error"));
        });
        a.play().catch(() => {
            this._stopped = true;
            this.dispatchEvent(new Event("error"));
        });
    }

    play() {
        if (this._idx === -1) this._playNext();
        else if (this._audio) this._audio.play().catch(() => {});
        return Promise.resolve();
    }

    pause() {
        this._stopped = true;
        if (this._audio) { try { this._audio.pause(); } catch (e) { /* ignore */ } }
    }

    get currentTime() { return this._audio ? this._audio.currentTime : 0; }
    set currentTime(v) { if (this._audio) { try { this._audio.currentTime = v; } catch (e) { /* ignore */ } } }
}

// ---------------------------------------------------------------------
// ElevenLabs — official API, needs elevenlabs_api_key.
// ---------------------------------------------------------------------
async function synthElevenLabs(text, voiceId, apiKey) {
    if (!apiKey || !voiceId) throw new Error("Add your ElevenLabs API key + voice ID first.");
    const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
        body: JSON.stringify({
            text,
            model_id: "eleven_multilingual_v2",
            voice_settings: { stability: 0.45, similarity_boost: 0.8 }
        })
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`ElevenLabs error ${response.status}: ${errText}`);
    }
    const blob = await response.blob();
    return new Audio(URL.createObjectURL(blob));
}

// ---------------------------------------------------------------------
// OpenAI — official API, needs openai_api_key.
// ---------------------------------------------------------------------
async function synthOpenAI(text, voiceId, apiKey) {
    if (!apiKey) throw new Error("Add your OpenAI API key first.");
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: "tts-1", voice: voiceId || "alloy", input: text })
    });
    if (!response.ok) {
        const errText = await response.text().catch(() => "");
        throw new Error(`OpenAI error ${response.status}: ${errText}`);
    }
    const blob = await response.blob();
    return new Audio(URL.createObjectURL(blob));
}

// ---------------------------------------------------------------------
// Google Translate TTS — unofficial, keyless, free. The endpoint doesn't
// send CORS headers, so fetch() would be blocked; loading it directly as
// an <audio src> sidesteps that (media playback isn't subject to CORS the
// way script-readable fetch is). ~200 char cap per request, so long text
// is split into sentence-sized chunks and chained.
// ---------------------------------------------------------------------
function splitForGoogle(text, maxLen = 180) {
    const sentences = text.split(/(?<=[.?!।])\s+/).filter(Boolean);
    const chunks = [];
    let cur = "";
    for (const s of sentences) {
        if ((cur + " " + s).trim().length > maxLen && cur) {
            chunks.push(cur.trim());
            cur = s;
        } else {
            cur = (cur + " " + s).trim();
        }
    }
    if (cur) chunks.push(cur.trim());
    // Absolute fallback for a single very long "sentence".
    return chunks.flatMap((c) => (c.length <= maxLen ? [c] : c.match(new RegExp(`.{1,${maxLen}}`, "g")) || [c]));
}

async function synthGoogle(text, langId) {
    const lang = langId || "en";
    const chunks = splitForGoogle(text);
    const urls = chunks.map((chunk, i) =>
        `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}` +
        `&q=${encodeURIComponent(chunk)}&textlen=${chunk.length}&idx=${i}&total=${chunks.length}`
    );
    const chained = new ChainedAudio(urls);
    return chained;
}

// ---------------------------------------------------------------------
// Microsoft Edge TTS — unofficial "read aloud" trial endpoint used by the
// Edge browser's own reader mode. Free, keyless, no per-request quota,
// but reverse-engineered: the auth token below (Sec-MS-GEC) is Microsoft's
// published trial algorithm, not a real credential, and the server can
// reject requests (403) based on things a static page can't fully spoof
// (Origin/handshake fingerprint). Best effort, direct from the browser.
// ---------------------------------------------------------------------
const EDGE_TRUSTED_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VERSION = "1-131.0.2903.51";
const WIN_EPOCH_OFFSET_SEC = 11644473600; // seconds between 1601-01-01 and 1970-01-01

async function sha256Hex(str) {
    const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function edgeSecMsGec() {
    // Round down to the nearest 5-minute (300s) boundary, in Windows
    // "file time" ticks (100-nanosecond intervals since 1601-01-01).
    const nowSec = Date.now() / 1000 + WIN_EPOCH_OFFSET_SEC;
    const ticks = Math.floor(nowSec / 300) * 300 * 10000000;
    const hash = await sha256Hex(`${ticks}${EDGE_TRUSTED_TOKEN}`);
    return hash.toUpperCase();
}

function uuidNoDashes() {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, "");
    return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

function parseEdgeBinaryFrame(buf) {
    const view = new DataView(buf);
    const headerLen = view.getUint16(0, false);
    const header = new TextDecoder().decode(new Uint8Array(buf, 2, headerLen));
    const audioBytes = new Uint8Array(buf, 2 + headerLen);
    return { header, audioBytes };
}

async function synthEdge(text, voiceId) {
    const voice = voiceId || "en-US-AriaNeural";
    const gec = await edgeSecMsGec();
    const connectionId = uuidNoDashes();
    const url =
        `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1` +
        `?TrustedClientToken=${EDGE_TRUSTED_TOKEN}&Sec-MS-GEC=${gec}` +
        `&Sec-MS-GEC-Version=${EDGE_VERSION}&ConnectionId=${connectionId}`;

    return new Promise((resolve, reject) => {
        let ws;
        try {
            ws = new WebSocket(url);
        } catch (err) {
            reject(err);
            return;
        }
        ws.binaryType = "arraybuffer";
        const audioParts = [];
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { ws.close(); } catch (e) { /* ignore */ }
            reject(err instanceof Error ? err : new Error("Microsoft Edge voice request failed (likely a 403 from the trial endpoint)."));
        };
        const timeout = setTimeout(() => fail(new Error("Microsoft Edge voice timed out.")), 15000);

        ws.addEventListener("open", () => {
            const reqId = uuidNoDashes();
            const configMsg =
                `Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
                JSON.stringify({
                    context: {
                        synthesis: {
                            audio: {
                                metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" },
                                outputFormat: "audio-24khz-48kbitrate-mono-mp3"
                            }
                        }
                    }
                });
            ws.send(configMsg);

            const ssml =
                `<speak version='1.0' xml:lang='en-US'>` +
                `<voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>` +
                `${text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}` +
                `</prosody></voice></speak>`;
            const ssmlMsg =
                `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`;
            ws.send(ssmlMsg);
        });

        ws.addEventListener("message", (evt) => {
            if (typeof evt.data === "string") {
                if (evt.data.includes("Path:turn.end")) {
                    clearTimeout(timeout);
                    if (settled) return;
                    settled = true;
                    const blob = new Blob(audioParts, { type: "audio/mpeg" });
                    try { ws.close(); } catch (e) { /* ignore */ }
                    resolve(new Audio(URL.createObjectURL(blob)));
                }
                return;
            }
            try {
                const { header, audioBytes } = parseEdgeBinaryFrame(evt.data);
                if (header.includes("Path:audio") && audioBytes.length) audioParts.push(audioBytes);
            } catch (err) { /* ignore malformed frame */ }
        });

        ws.addEventListener("error", () => fail(new Error("Microsoft Edge voice request failed (likely a 403 from the trial endpoint).")));
        ws.addEventListener("close", (evt) => {
            clearTimeout(timeout);
            if (!settled && evt.code !== 1000) fail(new Error(`Microsoft Edge voice closed unexpectedly (code ${evt.code}).`));
        });
    });
}

// ---------------------------------------------------------------------
// Public dispatch
// ---------------------------------------------------------------------
export async function synthesize(engine, text, voiceId, apiKey) {
    switch (engine) {
        case "elevenlabs": return synthElevenLabs(text, voiceId, apiKey);
        case "openai": return synthOpenAI(text, voiceId, apiKey);
        case "google": return synthGoogle(text, voiceId);
        case "edge": return synthEdge(text, voiceId);
        default: throw new Error(`Unknown TTS engine: ${engine}`);
    }
}
