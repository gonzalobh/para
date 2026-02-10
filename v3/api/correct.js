const SYSTEM_PROMPT = `Eres un corrector estricto de español.
Detecta errores de:
- ortografía (incluye tildes/diacríticos faltantes o incorrectos),
- puntuación (comas, puntos, signos de pregunta/exclamación, mayúscula tras punto),
- gramática.

Responde SOLO con JSON válido, sin texto adicional.
Para cada error:
- errorText DEBE ser una subcadena exacta del texto de entrada (copia/pega exacto).
- suggestion debe ser corta y directa.
- type solo puede ser: spelling, punctuation o grammar.

IMPORTANTE:
- Incluye correcciones por tildes/diacríticos faltantes y por puntuación faltante/incorrecta.
- Devuelve como máximo 12 errores.

Ejemplo:
Entrada: "el dijo como estas"
Salida:
{
  "errors": [
    { "errorText": "el", "suggestion": "Él", "type": "spelling" },
    { "errorText": "dijo", "suggestion": "dijo:", "type": "punctuation" },
    { "errorText": "como", "suggestion": "cómo", "type": "spelling" },
    { "errorText": "estas", "suggestion": "estás", "type": "spelling" }
  ]
}`;

const RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    errors: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          errorText: { type: "string" },
          suggestion: { type: "string" },
          type: {
            type: "string",
            enum: ["spelling", "punctuation", "grammar"]
          }
        },
        required: ["errorText", "suggestion", "type"]
      }
    }
  },
  required: ["errors"]
};

function parseModelJson(rawText) {
  const fallback = { errors: [] };
  const cleaned = (rawText || "")
    .replace(/```json\n?/g, "")
    .replace(/```\n?/g, "")
    .trim();

  if (!cleaned) return fallback;

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return { errors: parsed };
    if (parsed && Array.isArray(parsed.errors)) return { errors: parsed.errors };
  } catch (error) {
    console.error("Error parsing streamed response:", error);
  }

  return fallback;
}

function normalizeIndices(errors, sourceText) {
  const usedRanges = [];

  const isOverlapping = (start, end) =>
    usedRanges.some((range) => start < range.end && end > range.start);

  const markUsed = (start, end) => {
    usedRanges.push({ start, end });
    usedRanges.sort((a, b) => a.start - b.start || a.end - b.end);
  };

  const out = [];

  for (const rawError of (errors || []).slice(0, 12)) {
    const errorText = typeof rawError?.errorText === "string" ? rawError.errorText : "";
    const suggestion = typeof rawError?.suggestion === "string" ? rawError.suggestion : "";
    const type = ["spelling", "punctuation", "grammar"].includes(rawError?.type)
      ? rawError.type
      : "grammar";

    if (!errorText) continue;

    let idx = sourceText.indexOf(errorText);
    let start = -1;
    let end = -1;

    while (idx !== -1) {
      const candidateEnd = idx + errorText.length;
      if (candidateEnd > idx && !isOverlapping(idx, candidateEnd)) {
        start = idx;
        end = candidateEnd;
        break;
      }
      idx = sourceText.indexOf(errorText, idx + 1);
    }

    if (start === -1 || end === -1) continue;

    markUsed(start, end);
    out.push({
      errorText,
      suggestion,
      type,
      start,
      end
    });
  }

  return out;
}

function toUiErrors(errors) {
  const normalized = (errors || []).map((error, index) => ({
    id: index,
    type: error.type || "grammar",
    errorText: error.errorText || "",
    suggestion: error.suggestion || "",
    start: Number.isInteger(error.start) ? error.start : 0,
    end: Number.isInteger(error.end) ? error.end : 0,
    message: error.message || "Error detectado",
    context: "",
    rule: error.message || "",
    allSuggestions: error.suggestion ? [error.suggestion] : []
  }));

  return normalized;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ errors: [] });

  try {
    const { text } = req.body || {};
    const safeText = typeof text === "string" ? text.trim() : "";

    if (!safeText) return res.status(200).json({ errors: [] });
    if (safeText.length > 20000) return res.status(413).json({ errors: [] });

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    });

    const abortController = new AbortController();
    req.on("close", () => abortController.abort());

    res.write(`data: ${JSON.stringify({ type: "status", message: "Analizando texto..." })}\n\n`);

    const openaiResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      signal: abortController.signal,
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0,
        max_output_tokens: 800,
        stream: true,
        instructions: SYSTEM_PROMPT,
        input: safeText,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "spanish_corrections",
            strict: true,
            schema: RESPONSE_SCHEMA
          }
        }
      })
    });

    if (!openaiResponse.ok || !openaiResponse.body) {
      console.error("OpenAI Responses API error:", openaiResponse.status);
      res.write(`data: ${JSON.stringify({
        type: "error",
        status: openaiResponse.status,
        message: `OpenAI error ${openaiResponse.status}`
      })}\n\n`);
      return res.end();
    }

    const reader = openaiResponse.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let outputText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      const events = pending.split("\n\n");
      pending = events.pop() || "";

      for (const eventBlock of events) {
        const dataLine = eventBlock
          .split("\n")
          .find((line) => line.startsWith("data: "));

        if (!dataLine) continue;

        const payload = dataLine.slice(6).trim();
        if (!payload || payload === "[DONE]") continue;

        try {
          const parsed = JSON.parse(payload);

          if (parsed.type === "response.output_text.delta" && parsed.delta) {
            outputText += parsed.delta;
            res.write(`data: ${JSON.stringify({ type: "progress", message: "Analizando texto..." })}\n\n`);
          }

          if (parsed.type === "response.completed") {
            const completedText = parsed.response?.output_text;
            if (typeof completedText === "string" && completedText.trim()) {
              outputText = completedText;
            }
          }
        } catch (error) {
          console.error("Error processing OpenAI stream event:", error);
        }
      }
    }

    const parsedResult = parseModelJson(outputText);
    const normalizedErrors = normalizeIndices(parsedResult.errors, safeText);
    const uiErrors = toUiErrors(normalizedErrors);

    res.write(`data: ${JSON.stringify({ type: "result", errors: uiErrors })}\n\n`);
    return res.end();
  } catch (error) {
    if (error?.name !== "AbortError") {
      console.error("Error in correct handler:", error);
    }

    if (!res.headersSent) {
      return res.status(200).json({ errors: [] });
    }

    try {
      res.write(`data: ${JSON.stringify({
        type: "error",
        status: 500,
        message: "OpenAI error 500"
      })}\n\n`);
      res.end();
    } catch {
      res.end();
    }
  }
}
