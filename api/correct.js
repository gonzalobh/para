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

    // Usar OpenAI para detectar errores
    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: `Eres un corrector gramatical de español. Detecta TODOS los errores de ortografía, gramática, puntuación y acentuación en el texto.

Responde SOLO con un array JSON de errores. Cada error debe tener:
- errorText: texto con el error
- suggestion: corrección sugerida
- start: posición inicial (número)
- end: posición final (número)
- message: descripción del error
- type: "spelling", "grammar", "punctuation", o "typography"

Formato de respuesta:
[
  {
    "errorText": "palabra incorrecta",
    "suggestion": "palabra correcta",
    "start": 0,
    "end": 10,
    "message": "Descripción del error",
    "type": "spelling"
  }
]

Si no hay errores, responde con: []`
          },
          {
            role: "user",
            content: safeText
          }
        ],
        temperature: 0.1
      })
    });

    if (!openaiResponse.ok) {
      console.error("OpenAI API error:", openaiResponse.status);
      return res.status(200).json({ errors: [] });
    }

    const data = await openaiResponse.json();
    const content = data.choices?.[0]?.message?.content || "[]";
    
    // Limpiar respuesta (remover markdown si existe)
    const cleanContent = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    
    let errors = [];
    try {
      errors = JSON.parse(cleanContent);
    } catch (e) {
      console.error("Error parsing OpenAI response:", e);
      errors = [];
    }
    
    // Asignar IDs únicos
    const errorsWithIds = errors.map((error, index) => ({
      id: index,
      type: error.type || 'grammar',
      errorText: error.errorText,
      suggestion: error.suggestion,
      start: error.start,
      end: error.end,
      message: error.message || 'Error detectado',
      context: '',
      rule: error.message || '',
      allSuggestions: [error.suggestion]
    }));

    // ============================================
    // REGLAS PERSONALIZADAS ADICIONALES
    // ============================================
    const customErrors = [];
    let customIdCounter = errorsWithIds.length;
    
    // REGLA 1: Mayúscula después de coma (excepto nombres propios)
    const upperAfterCommaRegex = /,\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/g;
    let match;
    
    while ((match = upperAfterCommaRegex.exec(safeText)) !== null) {
      const word = match[1];
      
      // Excluir nombres propios comunes (lista básica)
      const properNouns = ['María', 'Juan', 'Pedro', 'Ana', 'Carlos', 'México', 'España', 'Argentina', 'Luis', 'José', 'Manuel'];
      if (!properNouns.includes(word)) {
        const offset = match.index + match[0].indexOf(word);
        
        // Verificar que no esté ya en los errores de OpenAI
        const alreadyDetected = errorsWithIds.some(e => 
          e.start === offset && e.end === offset + word.length
        );
        
        if (!alreadyDetected) {
          customErrors.push({
            id: customIdCounter++,
            type: 'grammar',
            errorText: word,
            suggestion: word.charAt(0).toLowerCase() + word.slice(1),
            start: offset,
            end: offset + word.length,
            message: 'Después de coma se usa minúscula (excepto nombres propios)',
            context: match[0],
            rule: 'Mayúscula después de coma',
            allSuggestions: [word.charAt(0).toLowerCase() + word.slice(1)]
          });
        }
      }
    }
    
    // REGLA 2: Espacios dobles
    const doubleSpaceRegex = /\s{2,}/g;
    while ((match = doubleSpaceRegex.exec(safeText)) !== null) {
      const alreadyDetected = errorsWithIds.some(e => 
        e.start === match.index && e.end === match.index + match[0].length
      );
      
      if (!alreadyDetected) {
        customErrors.push({
          id: customIdCounter++,
          type: 'typography',
          errorText: match[0],
          suggestion: ' ',
          start: match.index,
          end: match.index + match[0].length,
          message: 'Espacios duplicados',
          context: match[0],
          rule: 'Espacios múltiples',
          allSuggestions: [' ']
        });
      }
    }
    
    // REGLA 3: "a ver" vs "haber" (error común)
    const haberRegex = /\bhaber\s+si\b/gi;
    while ((match = haberRegex.exec(safeText)) !== null) {
      const alreadyDetected = errorsWithIds.some(e => 
        e.start === match.index && e.end === match.index + match[0].length
      );
      
      if (!alreadyDetected) {
        customErrors.push({
          id: customIdCounter++,
          type: 'grammar',
          errorText: match[0],
          suggestion: match[0].replace(/haber/i, m => m[0] === 'H' ? 'A ver' : 'a ver'),
          start: match.index,
          end: match.index + match[0].length,
          message: 'Confusión entre "a ver" y "haber". Usa "a ver" para verificar',
          context: match[0],
          rule: 'Confusión a ver/haber',
          allSuggestions: [match[0].replace(/haber/i, m => m[0] === 'H' ? 'A ver' : 'a ver')]
        });
      }
    }
    
    // REGLA 4: "echo" vs "hecho" (error común)
    const echoRegex = /\b(he|has|ha|hemos|habéis|han)\s+echo\b/gi;
    while ((match = echoRegex.exec(safeText)) !== null) {
      const wordStart = match.index + match[0].indexOf('echo');
      const alreadyDetected = errorsWithIds.some(e => 
        e.start === wordStart && e.end === wordStart + 4
      );
      
      if (!alreadyDetected) {
        customErrors.push({
          id: customIdCounter++,
          type: 'spelling',
          errorText: 'echo',
          suggestion: 'hecho',
          start: wordStart,
          end: wordStart + 4,
          message: 'Confusión entre "echo" (de echar) y "hecho" (de hacer). Usa "hecho" con el verbo haber',
          context: match[0],
          rule: 'Confusión echo/hecho',
          allSuggestions: ['hecho']
        });
      }
    }

    // Combinar errores de OpenAI con errores personalizados
    const allErrors = [...errorsWithIds, ...customErrors];
    
    return res.status(200).json({ errors: allErrors });
    
  } catch (error) {
    console.error("Error in correct handler:", error);
    return res.status(200).json({ errors: [] });
  }
}
