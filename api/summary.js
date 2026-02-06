export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const { text, mode, tone, customInstruction } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Texto vacío" });
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

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text }
        ],
        temperature: 0.6,
      }),
    });

    const data = await response.json();
    const paraphrasedText = data?.choices?.[0]?.message?.content?.trim();

    if (!paraphrasedText) {
      return res.status(502).json({ error: "No se pudo generar el texto" });
    }

    res.status(200).json({
      result: paraphrasedText,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error interno" });
  }
}
