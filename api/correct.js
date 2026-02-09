export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ errors: [] });

  try {
    const { text, language = "es" } = req.body || {};
    const safeText = typeof text === "string" ? text.trim() : "";

    if (!safeText) return res.status(200).json({ errors: [] });
    if (safeText.length > 20000) return res.status(413).json({ errors: [] });

    // Usar la API pública de LanguageTool
    const params = new URLSearchParams({
      text: safeText,
      language: language,
      enabledOnly: "false"
    });

    const upstream = await fetch("https://api.languagetool.org/v2/check", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: params
    });

    if (!upstream.ok) {
      console.error("LanguageTool API error:", upstream.status);
      return res.status(200).json({ errors: [] });
    }

    const data = await upstream.json();
    
    // Transformar la respuesta de LanguageTool al formato esperado por la app
    const errors = (data.matches || []).map((match, index) => {
      // Determinar el tipo de error
      let errorType = 'grammar';
      const category = match.rule?.category?.id || '';
      
      if (category.includes('TYPOS') || category.includes('SPELLING')) {
        errorType = 'spelling';
      } else if (category.includes('PUNCTUATION') || category.includes('TYPOGRAPHY')) {
        errorType = 'punctuation';
      }

      // Obtener la mejor sugerencia
      const suggestion = match.replacements?.[0]?.value || '';
      
      return {
        id: index,
        type: errorType,
        errorText: safeText.substring(match.offset, match.offset + match.length),
        suggestion: suggestion,
        start: match.offset,
        end: match.offset + match.length,
        message: match.message || 'Error detectado',
        context: match.context?.text || '',
        rule: match.rule?.description || '',
        // Incluir todas las sugerencias disponibles
        allSuggestions: match.replacements?.map(r => r.value) || []
      };
    });

    return res.status(200).json({ errors });
    
  } catch (error) {
    console.error("Error in correct handler:", error);
    return res.status(200).json({ errors: [] });
  }
}
