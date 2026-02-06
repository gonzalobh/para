export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  let streamClosed = false;
  let sseMode = false;

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    try { res.end(); } catch {}
  };

  const writeEvent = (payload) => {
    if (streamClosed) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {}
  };

  try {
    const { text, mode, tone, customInstruction } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Texto vacío" });
    }

    if (text.length > 16000) {
      return res.status(413).json({ error: "Texto demasiado largo" });
    }

    const MODE_PROMPTS = {
      Standard: "Parafrasea el texto manteniendo el significado original.",
      Fluency: "Mejora la fluidez y naturalidad del texto.",
      Humanizer: "Haz que el texto suene humano y natural.",
      Simplify: "Simplifica el texto usando lenguaje sencillo.",
      Creative: "Parafrasea el texto de forma creativa.",
      Academic: "Parafrasea el texto con estilo académico.",
      Shorten: `Parafrasea el texto de forma más breve.
Reglas obligatorias para este modo:
- El resultado DEBE tener MENOS caracteres que el texto original.
- Objetivo de reducción: entre 20% y 40% de caracteres.
- PROHIBIDO agregar información nueva.
- PROHIBIDO agregar contexto adicional.
- PROHIBIDO explicar o expandir ideas.
- PRIORIDAD: eliminar redundancias y condensar frases.
- Mantén hechos, nombres y datos exactamente.
- Si no puedes acortarlo sin perder sentido, reduce mínimamente.`,
      Expand: "Parafrasea el texto ampliándolo.",
      Rephraser: "Reformula el texto usando estructuras distintas.",
      Custom: customInstruction || "Parafrasea el texto."
    };

    const TONE_PROMPTS = {
      Formal: "Usa un tono formal.",
      Casual: "Usa un tono casual.",
      Professional: "Usa un tono profesional.",
      Witty: "Usa un tono ingenioso."
    };

    const SYSTEM_PROMPT = `
Eres un asistente experto en parafrasear textos en español.

${MODE_PROMPTS[mode] || MODE_PROMPTS.Standard}
${TONE_PROMPTS[tone] || ""}

REGLAS:
- Responde únicamente en español.
- Mantén el sentido original.
- No agregues explicaciones, comentarios ni formato extra.
- Devuelve SOLO texto plano parafraseado (sin etiquetas HTML).
`;

    const upstreamResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text }
        ],
        temperature: 0.6,
      }),
    });

    if (!upstreamResponse.ok || !upstreamResponse.body) {
      const errorText = await upstreamResponse.text();
      console.error("OpenAI upstream error:", errorText);
      return res.status(502).json({ error: "No se pudo generar el texto" });
    }

    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    sseMode = true;
    res.flushHeaders?.();
    res.write(":\n\n");

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let collectedText = "";
    const originalText = text;
    const isShortenMode = mode === "Shorten";
    let reachedDoneMarker = false;

    streamLoop: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.replace(/^data:\s*/, "");

        if (data === "[DONE]") {
          reachedDoneMarker = true;
          break streamLoop;
        }

        try {
          const parsed = JSON.parse(data);
          const chunk = parsed?.choices?.[0]?.delta?.content || "";

          if (chunk) {
            collectedText += chunk;
            if (!isShortenMode) {
              writeEvent({ type: "chunk", text: chunk });
            }
          }
        } catch (parseError) {
          console.error("Error parsing stream chunk", parseError);
        }
      }
    }

    if (!reachedDoneMarker) {
      buffer += decoder.decode();
    }

    if (!collectedText.trim()) {
      writeEvent({ type: "error", message: "No se pudo generar el texto. Intenta nuevamente." });
      writeEvent({ type: "done" });
      return;
    }

    if (isShortenMode) {
      if (collectedText.length >= originalText.length) {
        writeEvent({
          type: "error",
          message: "No fue posible acortar el texto sin perder sentido. Intenta otro modo."
        });
        writeEvent({ type: "done" });
        return;
      }

      writeEvent({ type: "chunk", text: collectedText });
    }

    writeEvent({ type: "done" });
  } catch (err) {
    console.error(err);

    if (!sseMode) {
      return res.status(500).json({ error: "Error interno" });
    }

    writeEvent({ type: "error", message: "No se pudo generar el texto. Intenta nuevamente." });
    closeStream();
  } finally {
    closeStream();
  }
}
