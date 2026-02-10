export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ synonyms: [] });
  }

  try {
    const { word, context = "", mode = "humanizar" } = req.body || {};
    const safeWord = typeof word === "string" ? word.trim() : "";
    const safeContext = typeof context === "string" ? context.slice(0, 900) : "";

    if (!safeWord || safeWord.length > 40 || !/[\p{L}]/u.test(safeWord)) {
      return res.status(200).json({ synonyms: [] });
    }

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
          {
            role: "system",
            content: "Eres un editor experto en español. Devuelve 3 o 4 sinónimos que ENCAJEN en el contexto y mantengan el mismo significado. Si no hay sinónimos seguros, devuelve lista vacía."
          },
          {
            role: "user",
            content: `palabra: \"${safeWord}\"\ncontexto: \"${safeContext}\"\nmodo: \"${mode}\"\nFormato de salida OBLIGATORIO: JSON estricto:\n{\"synonyms\":[\"...\",\"...\",\"...\"]}`
          }
        ]
      })
    });

    if (!response.ok) {
      return res.status(200).json({ synonyms: [] });
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      const maybeJson = content.match(/\{[\s\S]*\}/)?.[0] || "";
      parsed = maybeJson ? JSON.parse(maybeJson) : { synonyms: [] };
    }

    const synonyms = Array.isArray(parsed?.synonyms)
      ? parsed.synonyms
          .filter(item => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean)
          .filter(item => item.toLowerCase() !== safeWord.toLowerCase())
          .slice(0, 4)
      : [];

    return res.status(200).json({ synonyms });
  } catch {
    return res.status(200).json({ synonyms: [] });
  }
}
