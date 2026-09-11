import { createFileRoute } from "@tanstack/react-router";

const MAX_BYTES = 12 * 1024 * 1024;

export const Route = createFileRoute("/api/public/stt")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = process.env["LOVABLE_API_KEY"];
        if (!apiKey) {
          return new Response(JSON.stringify({ error: "Speech service is not configured." }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }

        let form: FormData;
        try {
          form = await request.formData();
        } catch {
          return new Response(JSON.stringify({ error: "Expected an audio upload." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }

        const file = form.get("file");
        const language = String(form.get("language") || "").trim();
        if (!(file instanceof File) || file.size === 0) {
          return new Response(JSON.stringify({ error: "No audio received." }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (file.size > MAX_BYTES) {
          return new Response(JSON.stringify({ error: "Recording is too long." }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }

        const upstreamForm = new FormData();
        upstreamForm.append("model", "google/gemini-3.5-transcribe");
        upstreamForm.append("file", file, file.name || "recording.webm");
        if (/^[a-z]{2}$/.test(language)) upstreamForm.append("language", language);

        const upstream = await fetch("https://ai.gateway.lovable.dev/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}` },
          body: upstreamForm,
        });

        const raw = await upstream.text();
        if (!upstream.ok) {
          console.error(`[stt] gateway failed [${upstream.status}]: ${raw}`);
          return new Response(
            JSON.stringify({ error: `Speech service error ${upstream.status}: ${raw.slice(0, 300)}` }),
            { status: upstream.status, headers: { "Content-Type": "application/json" } },
          );
        }

        let text = "";
        try {
          text = (JSON.parse(raw)?.text || "").trim();
        } catch {
          text = raw.trim();
        }

        return new Response(JSON.stringify({ text }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      },
    },
  },
});
