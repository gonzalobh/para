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

    // =========================
    // MODE PROMPTS (AFILADOS)
    // =========================
    const MODE_PROMPTS = {
      Standard: `
Reescribe el texto manteniendo el significado original.
- Cambia vocabulario y orden de frases de forma leve.
- NO agregues ni elimines información.
- Mantén el tono y la estructura general.
`,

      Shorten: `
Reescribe el texto de forma más breve.

REGLAS OBLIGATORIAS:
- El resultado DEBE tener MENOS caracteres que el texto original.
- Objetivo de reducción: entre 20% y 40%.
- PROHIBIDO agregar información nueva o contexto adicional.
- Elimina redundancias y frases accesorias.
- Mantén hechos, nombres propios y datos exactamente.
- Si no puedes acortarlo sin perder sentido, reduce mínimamente.
`,

      Expand: `
Reescribe el texto ampliándolo de forma clara y coherente.
- Desarrolla ideas implícitas.
- Agrega contexto explicativo ligero, sin inventar hechos.
- Mantén estilo informativo.
- El resultado DEBE ser más largo que el texto original.
`,

      Simplify: `
Simplifica el texto para que sea fácil de entender.
- Usa frases cortas.
- Usa vocabulario común.
- Evita tecnicismos y subordinadas largas.
- Nivel lector aproximado: educación secundaria.
- Mantén el significado original sin agregar información.
`,

      Creative: `
Reescribe el texto desde un ángulo distinto.
- Cambia el punto de entrada del texto (no empieces igual).
- Varía ritmo y estructura.
- Puedes reorganizar el contenido.
- NO inventes hechos ni datos.
- El resultado debe sentirse claramente distinto al original.
`,

      Custom: customInstruction || "Parafrasea el texto."
    };

    const TONE_PROMPTS = {
      Formal: "Usa un tono formal.",
      Casual: "Usa un tono casual.",
      Professional: "Usa un tono profesional.",
      Witty: "Usa un tono ingenioso."
    };

    // =========================
    // SYSTEM PROMPT
    // =========================
    const SYSTEM_PROMPT = `
Eres un asistente profesional especializado en reescritura y edición de textos en español.

Tu tarea es ejecutar EXACTAMENTE el modo solicitado.
Cada modo tiene un objetivo distinto y debes respetarlo estrictamente.

${MODE_PROMPTS[mode] || MODE_PROMPTS.Standard}
${TONE_PROMPTS[tone] || ""}

REGLAS GENERALES:
- Responde únicamente en español.
- No expliques lo que haces.
- No agregues comentarios ni aclaraciones.
- No uses listas, títulos ni formato especial.
- Devuelve SOLO el texto final reescrito, en texto plano.
`;

    // =========================
    // OPENAI STREAMING
    // =========================
    const upstreamResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        stream: true,
        temperature: 0.6,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text }
        ],
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

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.replace(/^data:\s*/, "");
        if (data === "[DONE]") break;

        try {
          const parsed = JSON.parse(data);
          const chunk = parsed?.choices?.[0]?.delta?.content || "";

          if (chunk) {
            collectedText += chunk;
            if (!isShortenMode) {
              writeEvent({ type: "chunk", text: chunk });
            }
          }
        } catch (err) {
          console.error("Stream parse error:", err);
        }
      }
    }

    if (!collectedText.trim()) {
      writeEvent({ type: "error", message: "No se pudo generar el texto. Intenta nuevamente." });
      writeEvent({ type: "done" });
      return;
    }

    // =========================
    // SHORTEN VALIDATION
    // =========================
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
