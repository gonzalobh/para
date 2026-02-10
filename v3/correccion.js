const textarea = document.getElementById("texto");
const boton = document.getElementById("revisar");
const lista = document.getElementById("errores");

boton.addEventListener("click", async () => {
  const texto = textarea.value.trim();
  lista.innerHTML = "";

  if (!texto) {
    alert("Escribe algo primero");
    return;
  }

  try {
    const res = await fetch("/api/correct", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: texto })
    });

    if (!res.ok) {
      throw new Error("Error en API");
    }

    // Si usas SSE, aquí NO.
    // Este test asume respuesta JSON normal:
    const data = await res.json();

    if (!data.errors || data.errors.length === 0) {
      lista.innerHTML = "<li>✅ No se encontraron errores</li>";
      return;
    }

    data.errors.forEach(err => {
      const li = document.createElement("li");
      li.textContent = `❌ "${err.errorText}" → "${err.suggestion}" (${err.type})`;
      lista.appendChild(li);
    });

  } catch (e) {
    console.error(e);
    lista.innerHTML = "<li>⚠️ Error al conectar con OpenAI</li>";
  }
});
