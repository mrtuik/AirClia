// voice/stt.js
// AirC Speech-to-Text module.
//
// Captures raw microphone audio via getUserMedia + a small local
// voice-activity detector (VAD), and sends each detected utterance to
// ElevenLabs' Speech-to-Text (Scribe) API for transcription.
//
// This deliberately does NOT use the browser's built-in SpeechRecognition
// API. On Android, every recognition.start()/stop() call plays an
// OS-level chime with no way to silence it from JavaScript — and a
// hands-free app that's stopping/starting recognition on every reply
// turn means that chime fires constantly. Raw getUserMedia capture has
// no such sound (just a silent "mic in use" indicator), so this is the
// only way to make listening genuinely quiet.

const START_THRESHOLD = 0.035;   // RMS-ish level that counts as "speech begins"
const STOP_THRESHOLD = 0.02;     // level that counts as "gone quiet" once talking
const START_HOLD_MS = 120;       // must stay above START_THRESHOLD this long to count
const SILENCE_HOLD_MS = 650;     // must stay below STOP_THRESHOLD this long to finalize (was 900 — trimmed for a snappier turn-around)
const MIN_UTTERANCE_MS = 300;    // discard anything shorter (taps, coughs, noise)
const MAX_UTTERANCE_MS = 20000;  // hard cap so a stuck recording can't run forever
const MIN_BLOB_BYTES = 800;      // discard near-empty recordings

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", ""];

function pickMimeType() {
    if (typeof MediaRecorder === "undefined" || !MediaRecorder.isTypeSupported) return "";
    return MIME_CANDIDATES.find((t) => t === "" || MediaRecorder.isTypeSupported(t)) || "";
}

export class AirCSTT {
    /**
     * @param {object} config - AirCConfig instance (used for the
     *   ElevenLabs API key and the current language, read fresh on every
     *   transcription request).
     */
    constructor(config) {
        this.config = config;