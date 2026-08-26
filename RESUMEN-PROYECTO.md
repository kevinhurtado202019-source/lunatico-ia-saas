# LunaticoIA — Resumen del proyecto

Actualizado: 26 de agosto de 2026 (última actualización: la IA busca de forma más autónoma y las etiquetas de modelo muestran la versión real)

---

## ✅ Todo lo que ya está funcionando en producción (lunaticoia.uk)

### Pagos y créditos
- **Wompi 100% en producción**, verificado con una compra real: pagas con Nequi, PSE o tarjeta, en pesos colombianos, sin mensualidad.
- 4 paquetes de créditos (Prueba $9.900, Básico $24.900, Popular $54.900, Pro $129.900). Los créditos no caducan.
- Los créditos se abonan solos apenas Wompi confirma el pago (webhook automático).
- **Celebración al comprar**: al volver del pago, sale un mensaje de "¡Felicidades!" con confeti animado y un sonido corto — así el cliente siente que la compra sí funcionó.
- **Aviso por correo cuando el saldo está por acabarse** — llega justo cuando cruza el umbral bajo, no en cada mensaje.
- **Programa de referidos**: cada usuario tiene su link de invitación; si alguien se registra con él, los dos ganan créditos.
- Cuenta del dueño con créditos ilimitados.

### La inteligencia artificial
- 4 modelos para elegir, con el modelo real a la vista: **Rápido (Haiku 4.5)**, **Equilibrado (Sonnet 5)**, **Avanzado (Opus 5)**, **Máximo (Fable 5)**.
- Puede **buscar en internet**, **abrir páginas web** y **ejecutar código** cuando hace falta — y ahora lo hace de forma más autónoma: encadena varias búsquedas y lecturas de página sola, sin detenerse a preguntar "¿sigo buscando?", hasta 8 búsquedas y 10 lecturas de página por respuesta (antes 5 y 5).
- Instruida para usar la búsqueda en preguntas de actualidad (noticias, sismos, precios, etc.) en vez de decir que no tiene información actualizada.
- **Respuestas en streaming**: el texto aparece palabra por palabra a medida que la IA responde, como ChatGPT — ya no hay que esperar a que termine toda la respuesta para ver algo.
- Si preguntan quién la creó, responde con tu nombre.

### Archivos y adjuntos
- Se pueden adjuntar **imágenes, PDF, Word (.docx), Excel (.xlsx) y .zip** (del .zip solo se leen los archivos de texto/código de adentro).
- Los adjuntos se recuerdan dentro de la misma conversación (no solo en el mensaje en que se mandan).
- Botones para **copiar** o **descargar** el código y las respuestas completas, y para **compartir una respuesta puntual por link público** (sin que quien lo vea necesite cuenta).

### Organización de conversaciones
- **Proyectos**: agrupar conversaciones con nombre, cada uno con su propio historial e instrucciones propias.
- **Instrucciones personalizadas**: tono, idioma, formato — tanto generales de la cuenta como específicas por proyecto.
- Memoria de hasta 30 mensajes de contexto por conversación.

### Voz
- Dictado por voz (hablas y se escribe solo).
- Lectura en voz alta de las respuestas.
- Gratis, sin ninguna cuenta ni tarjeta de terceros de por medio (lo hace el propio navegador).

### Cuentas y seguridad
- Registro, inicio de sesión, verificación de correo y recuperación de contraseña, todo funcionando.
- Panel de administrador (solo para tu cuenta) con el uso de cada usuario: saldo, modelos que usa, mensajes totales.

### La web como app
- **Instalable como PWA**: en Android/Chrome aparece un botón "Descargar app" que la instala como cualquier otra app, sin pasar por Play Store ni por la advertencia de "archivo de fuente desconocida" que da un .apk suelto.
- **APK de descarga directa** también disponible, junto al de instalar como PWA.
- Preparada técnicamente como TWA para Play Store (assetlinks.json, política de privacidad) — falta el trámite de publicarla de verdad en la tienda (ver pendientes).
- Diseño responsive y accesible en computador y celular.

### Motor técnico por dentro
- SDK de Anthropic actualizado (de 0.20.9 a 0.120.0) y Node subido de 14 a 20 en Railway — ya no está en una versión vieja de 2024.
- El servidor real desde donde se trabaja y se despliega es esta carpeta; el código también queda respaldado en GitHub (`kevinhurtado202019-source/lunatico-ia-saas`), y cada `git push` a la rama `main` despliega solo a producción.

---

## ⏳ Lo único que queda pendiente

1. **El nombre del comercio en Wompi** sigue diciendo "interrapidisimo" en vez de "LunaticoIA" — ya está aprobado y recibiendo pagos igual, es solo cosmético del lado de Wompi. Cuando te lo actualicen, no hay que tocar nada aquí.
2. **Publicar de verdad en Google Play** — todo el paso técnico ya está listo (PWA + TWA + política de privacidad + APK), falta el trámite de subirla a la Play Console.
3. Cosas sin apuro: respaldos automáticos de la base de datos, y que recuerde conversaciones más allá de los últimos 30 mensajes.

---

*Este resumen es una versión en lenguaje simple del archivo técnico `LEEME.md` del proyecto, que tiene todo el detalle de cómo está construido cada cosa.*
