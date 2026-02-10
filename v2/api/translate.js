export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ translation: "" });

  try {
    const { text, target } = req.body || {};
    const safeText = typeof text === "string" ? text.trim() : "";
    const allowed = new Set(["en", "fr", "de", "pt"]);
    const safeTarget = allowed.has(target) ? target : "en";

    if (!safeText) return res.status(200).json({ translation: "" });
    if (safeText.length > 16000) return res.status(413).json({ translation: "" });

    const targetName = ({ en: "English", fr: "French", de: "German", pt: "Portuguese" })[safeTarget];

    const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Eres un traductor profesional. Traduce fielmente, sin añadir información, preservando nombres propios, números, URLs y saltos de línea. Devuelve SOLO el texto traducido."
          },
          {
            role: "user",
            content: `Translate to: ${targetName}\n\nTEXT:\n<<<\n${safeText}\n>>>`
          }
        ],
      }),
    });

    if (!upstream.ok) {
      return res.status(200).json({ translation: "" });
    }

    const data = await upstream.json();
    const translation = (data?.choices?.[0]?.message?.content || "").trim();
    return res.status(200).json({ translation });
  } catch {
    return res.status(200).json({ translation: "" });
  }
}
