export default async function handler(req, res) {
  // =========================
  // CORS
  // =========================
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages inválido o ausente" });
    }

    const SYSTEM_PROMPT = `
Eres un asistente experto en resumir textos.

OBJETIVO:
- Entregar un resumen claro, corto y fiel al contenido original.
- Eliminar redundancias.
- Mantener las ideas clave.
- No agregar opiniones ni información nueva.

REGLAS:
- Usa lenguaje simple.
- Máximo 1–2 párrafos.
- Si el texto es muy largo, prioriza lo esencial.
`;

    const fullMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...messages,
    ];

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: fullMessages,
        temperature: 0.3,
      }),
    });

    const data = await response.json();

    return res.status(200).json({
      message: data.choices[0].message.content,
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Error interno del servidor" });
  }
}
