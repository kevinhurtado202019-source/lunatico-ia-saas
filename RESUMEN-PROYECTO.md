# LunaticoIA — Resumen del proyecto

Actualizado: 25 de agosto de 2026

---

## ✅ Todo lo que ya está funcionando en producción (lunaticoia.uk)

### Pagos y créditos
- **Wompi 100% en producción**, verificado con una compra real: pagas con Nequi, PSE o tarjeta, en pesos colombianos, sin mensualidad.
- 4 paquetes de créditos (Prueba $9.900, Básico $24.900, Popular $54.900, Pro $129.900). Los créditos no caducan.
- Los créditos se abonan solos apenas Wompi confirma el pago (webhook automático).
- Cuenta del dueño con créditos ilimitados.

### La inteligencia artificial
- 4 modelos para elegir: Rápido, Equilibrado, Avanzado y Máximo (según qué tan potente necesites la respuesta).
- Puede **buscar en internet**, **abrir páginas web** y **ejecutar código** cuando hace falta.
- Instruida para usar la búsqueda en preguntas de actualidad (noticias, sismos, precios, etc.) en vez de decir que no tiene información actualizada.
- Si preguntan quién la creó, responde con tu nombre.

### Archivos y adjuntos
- Se pueden adjuntar **imágenes, PDF, Word (.docx), Excel (.xlsx) y .zip**.
- Los adjuntos se recuerdan dentro de la misma conversación (no solo en el mensaje en que se mandan).
- Botones para **copiar** o **descargar** el código y las respuestas completas.

### Organización de conversaciones
- **Proyectos**: agrupar conversaciones con nombre, cada uno con su propio historial e instrucciones propias.
- **Instrucciones personalizadas**: tono, idioma, formato — tanto generales de la cuenta como específicas por proyecto.
- Memoria de hasta 30 mensajes de contexto por conversación.

### Voz
- Dictado por voz (hablas y se escribe solo).
- Lectura en voz alta de las respuestas.
- Gratis, sin ninguna cuenta ni tarjeta de terceros de por medio.

### Cuentas y seguridad
- Registro, inicio de sesión, verificación de correo y recuperación de contraseña, todo funcionando.
- Panel de administrador (solo para tu cuenta) con el uso de cada usuario: saldo, modelos que usa, mensajes totales.

### La web como app
- **Instalable como PWA**: en Android/Chrome aparece un botón "Descargar app" que la instala como cualquier otra app, sin pasar por Play Store ni por la advertencia de "archivo de fuente desconocida" que da un .apk suelto.
- Diseño responsive y accesible en computador y celular.

---

## ⏳ Lo único que queda pendiente

1. **El nombre del comercio en Wompi** sigue diciendo "interrapidisimo" en vez de "LunaticoIA" — ya está aprobado y recibiendo pagos igual, es solo cosmético del lado de Wompi. Cuando te lo actualicen, no hay que tocar nada aquí.
2. **Streaming de respuestas** (que el texto aparezca palabra por palabra, como ChatGPT) — se intentó dos veces y ambas rompieron la aplicación en producción; se revirtió las dos veces. Queda pendiente para retomarlo con más cuidado más adelante.
3. **Actualizar la versión del programa que conecta con la IA** (sigue en una versión de 2024) — también se intentó y rompió producción; revertido. Mismo caso que el punto anterior.
4. **Subirla a Google Play** (como app de verdad, no solo instalable desde el navegador) — el paso técnico para esto ya está listo (la PWA), falta empacarla y publicarla si se quiere llegar ahí.
5. Cosas sin apuro: respaldos automáticos de la base de datos, y que recuerde conversaciones más allá de los últimos 30 mensajes.

---

*Este resumen es una versión en lenguaje simple del archivo técnico `LEEME.md` del proyecto, que tiene todo el detalle de cómo está construido cada cosa.*
