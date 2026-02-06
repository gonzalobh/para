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
    const { text, mode, customInstruction } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Texto vacío" });
    }

    if (text.length > 16000) {
      return res.status(413).json({ error: "Texto demasiado largo" });
    }

    // =========================
    // MODE PROMPTS
    // =========================
    const MODE_PROMPTS = {
      Standard: `
Reescribe el texto manteniendo exactamente el mismo significado.
- Cambia vocabulario y orden de frases.
- NO agregues ni elimines información.
- Mantén todos los hechos y datos intactos.
`,

      Shorten: `
Reescribe el texto de forma más breve.
- El resultado DEBE ser más corto que el original.
- Elimina redundancias.
- NO elimines hechos ni información relevante.
- NO agregues información nueva.
`,

      Expand: `
Reescribe el texto con una redacción ligeramente más desarrollada.
- Mejora fluidez y cohesión.
- NO agregues contexto, explicaciones ni hechos nuevos.
- No cambies el foco del texto.
`,

      Simplify: `
Reescribe el texto de forma más simple y clara.
- Usa frases más cortas.
- Usa vocabulario común.
- Mantén exactamente el mismo contenido informativo.
- NO agregues ejemplos ni explicaciones.
`,

      Creative: `
Reescribe el texto con variación estilística.
- Cambia estructura y ritmo.
- Mantén exactamente los mismos hechos e información.
- NO agregues contexto ni interpretaciones.
`,

      Custom: customInstruction || "Parafrasea el texto."
    };

    // =========================
    // SYSTEM PROMPT
    // =========================
    const SYSTEM_PROMPT = `
Eres un editor profesional especializado exclusivamente en PARAFRASEO FIEL de textos en español.

REGLA CRÍTICA (NO NEGOCIABLE):
- Está TERMINANTEMENTE PROHIBIDO agregar información nueva.
- NO inventes contexto, causas, consecuencias, intenciones, interpretaciones ni explicaciones.
- Si un dato, idea o matiz NO está explícitamente presente en el texto original, NO debe aparecer en el resultado.

Tu único objetivo es expresar EXACTAMENTE las mismas ideas, hechos y datos,
usando palabras y estructuras distintas.

MODO DE REESCRITURA:
${MODE_PROMPTS[mode] || MODE_PROMPTS.Standard}


REGLAS OBLIGATORIAS:
- Mantén todos los nombres propios, cifras, lugares y hechos.
- No cambies el foco del texto.
- No embellezcas ni editorialices.
- No agregues adjetivos interpretativos.
- No resumas salvo que el modo sea "Shorten".
- No repitas ideas ni infles el texto.
- Devuelve SOLO el texto final.
- Texto plano, sin listas, sin títulos.
- Español neutro.

VALIDACIÓN IMPLÍCITA DE CALIDAD:
Si no puedes cumplir un modo sin agregar información,
prioriza SIEMPRE la fidelidad semántica por encima de la creatividad o expansión.
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
        model: "gpt-4o",
        stream: true,
        temperature: 0.2,
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
