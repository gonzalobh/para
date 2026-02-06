const MODEL = "gpt-4o-mini";

function detectLanguage(text) {
  const sample = (text || "").toLowerCase();
  const spanishSignals = /\b(el|la|los|las|de|que|para|con|una|por|como|está|también)\b/g;
  const englishSignals = /\b(the|and|for|with|this|that|is|are|was|were|from)\b/g;

  const esCount = (sample.match(spanishSignals) || []).length;
  const enCount = (sample.match(englishSignals) || []).length;

  if (esCount === enCount) return "es";
  return esCount > enCount ? "es" : "en";
}

function lengthInstruction(lengthControl, maxChars, inputText) {
  if (lengthControl === "reduce20") {
    return "Reduce la longitud aproximadamente un 20% respecto al original.";
  }

  if (lengthControl === "maxChars") {
    const safeMax = Number(maxChars);
    if (Number.isFinite(safeMax) && safeMax > 0) {
      return `Debes entregar un texto de máximo ${safeMax} caracteres. Esta regla es estricta e innegociable.`;
    }
  }

  return `Mantén una longitud muy similar al original (referencia: ${inputText.length} caracteres).`;
}

function keywordsInstruction(rawKeywords) {
  const list = String(rawKeywords || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (!list.length) return "";

  return `Las siguientes palabras deben mantenerse EXACTAMENTE iguales, sin traducir ni alterar mayúsculas: ${list.join(", ")}.`;
}

async function streamVariant({ res, variantKey, variantPrompt, basePrompt, text, onChunk }) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      temperature: 0.7,
      messages: [
        { role: "system", content: `${basePrompt}\n${variantPrompt}` },
        { role: "user", content: text },
      ],
    }),
  });

  if (!response.ok || !response.body) {
    const details = await response.text().catch(() => "");
    throw new Error(`OpenAI stream error (${variantKey}): ${response.status} ${details}`);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let pending = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    pending += decoder.decode(value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.replace(/^data:\s*/, "");
      if (payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        const content = parsed?.choices?.[0]?.delta?.content || "";
        if (!content) continue;
        onChunk?.(content);
        res.write(`${JSON.stringify({ type: "chunk", variant: variantKey, content })}\n`);
      } catch {
        // ignore malformed chunks
      }
    }
  }

  res.write(`${JSON.stringify({ type: "variant_done", variant: variantKey })}\n`);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const {
      text,
      mode,
      tone,
      customInstruction,
      outputLanguage = "auto",
      lockedKeywords,
      lengthControl = "keep",
      maxChars,
    } = req.body || {};

    if (!text) {
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
      Shorten: "Parafrasea el texto haciéndolo más corto.",
      Expand: "Parafrasea el texto ampliándolo.",
      Rephraser: "Reformula el texto usando estructuras distintas.",
      Custom: customInstruction || "Parafrasea el texto.",
    };

    const TONE_PROMPTS = {
      Formal: "Usa un tono formal.",
      Casual: "Usa un tono casual.",
      Professional: "Usa un tono profesional.",
      Witty: "Usa un tono ingenioso.",
    };

    const resolvedLanguage = outputLanguage === "auto" ? detectLanguage(text) : outputLanguage;
    const languagePrompt = resolvedLanguage === "en"
      ? "Responde únicamente en inglés."
      : "Responde únicamente en español.";

    const basePrompt = [
      "Eres un asistente experto en parafrasear textos para periodistas, académicos y copywriters.",
      MODE_PROMPTS[mode] || MODE_PROMPTS.Standard,
      TONE_PROMPTS[tone] || "",
      languagePrompt,
      lengthInstruction(lengthControl, maxChars, text),
      keywordsInstruction(lockedKeywords),
      "Mantén el sentido original.",
      "No agregues explicaciones, comentarios ni formato extra.",
      "Devuelve SOLO texto plano parafraseado (sin etiquetas HTML).",
    ].filter(Boolean).join("\n");

    const variants = {
      short: "Genera una versión corta y directa.",
      standard: "Genera una versión estándar equilibrada.",
      creative: "Genera una versión creativa con léxico más rico, sin perder fidelidad.",
    };

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    const collected = { short: "", standard: "", creative: "" };

    for (const [variantKey, variantPrompt] of Object.entries(variants)) {
      await streamVariant({
        res,
        variantKey,
        variantPrompt,
        basePrompt,
        text,
        onChunk: (chunk) => {
          collected[variantKey] += chunk;
        },
      });
    }

    res.write(`${JSON.stringify({ type: "done", variants: collected })}\n`);
    res.end();
  } catch (err) {
    console.error(err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Error interno" });
    }
    res.write(`${JSON.stringify({ type: "error", message: "No se pudo conectar. Revisa tu conexión." })}\n`);
    res.end();
  }
}
