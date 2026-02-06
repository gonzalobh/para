export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método no permitido" });
  }

  const { effect, selectedText, before = "", after = "" } = req.body || {};
  if (!selectedText) {
    return res.status(400).json({ error: "Texto vacío" });
  }

  const EFFECTS = {
    simplify: "Reescribe el texto de forma más simple y clara.",
    professional: "Reescribe el texto con un tono más profesional."
  };

  const systemPrompt = `
Eres un editor profesional en español.

REGLAS ABSOLUTAS:
- Mantén exactamente el mismo significado
- NO agregues información
- Devuelve SOLO el texto reescrito, sin comillas ni listas

Contexto (NO modificar):
ANTES: """${before}"""
DESPUÉS: """${after}"""
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${EFFECTS[effect]}\n\n${selectedText}` }
      ]
    })
  });

  const data = await response.json();
  const replacement = data?.choices?.[0]?.message?.content?.trim();

  if (!replacement) {
    return res.status(500).json({ error: "Respuesta vacía" });
  }

  res.status(200).json({ replacement });
}
