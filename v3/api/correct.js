const SYSTEM_PROMPT = `Eres un corrector estricto de español.
Detecta errores de:
- ortografía (incluye tildes/diacríticos faltantes o incorrectos),
- puntuación (comas, puntos, signos de pregunta/exclamación, mayúscula tras punto),
- gramática.

Responde SOLO con JSON válido, sin texto adicional.
Para cada error:
- suggestion debe ser corta y directa.
- start y end deben ser índices exactos (JS string indices) del fragmento en el texto original.
- end siempre debe ser mayor que start.
- type solo puede ser: spelling, punctuation o grammar.`;

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
          start: { type: "integer" },
          end: { type: "integer" },
          type: {
            type: "string",
            enum: ["spelling", "punctuation", "grammar"]
          }
        },
        required: ["errorText", "suggestion", "start", "end", "type"]
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

  for (const error of errors || []) {
    const entry = { ...error };
    const hasValidIndices = Number.isInteger(entry.start) && Number.isInteger(entry.end) && entry.end > entry.start;

    if (!hasValidIndices) {
      const needle = typeof entry.errorText === "string" ? entry.errorText : "";
      if (!needle) continue;

      let idx = sourceText.indexOf(needle);
      let matched = false;
      while (idx !== -1) {
        const end = idx + needle.length;
        if (end > idx && !isOverlapping(idx, end)) {
          entry.start = idx;
          entry.end = end;
          matched = true;
          break;
        }
        idx = sourceText.indexOf(needle, idx + 1);
      }

      if (!matched) continue;
    }

    if (!Number.isInteger(entry.start) || !Number.isInteger(entry.end) || entry.end <= entry.start) {
      continue;
    }

    if (entry.start < 0 || entry.end > sourceText.length) {
      continue;
    }

    if (isOverlapping(entry.start, entry.end)) {
      continue;
    }

    markUsed(entry.start, entry.end);
    out.push(entry);
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
