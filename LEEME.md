# LunaticoIA

Backend y frontend de la plataforma. Estado al 23 de agosto de 2026.

---

## Qué hay aquí

| Archivo | Qué es |
|---|---|
| `server-saas.js` | El backend completo. Es el que arranca Railway (`npm start`). |
| `index.html` | Landing, acceso y aplicación de chat, todo en un archivo. Lo sirve el propio backend. |
| `package.json` | Dependencias. |
| `mensaje-soporte-wompi.txt` | Mensaje listo para pegar en el chat de soporte de Wompi. |
| `pruebas/` | La batería de pruebas. Ver más abajo. |
| `HACER-TODO.bat` | Doble clic: instala dependencias y guarda el código en git. |

> Estos dos archivos son los que están desplegados en producción, salvo el
> último lote de cambios (errores saneados, sincronización entre pestañas,
> alto en móvil, verificación de correo y recuperación de contraseña), que
> quedó pendiente de subir a GitHub.

---

## Variables de entorno

**Obligatorias.** Si falta alguna, el servidor no arranca y lo dice en el log.

```
MONGODB_URI      Cadena de conexión. Debe llevar ?authSource=admin
JWT_SECRET       Cadena larga y aleatoria para firmar las sesiones
CLAUDE_API_KEY   Clave de la API de Anthropic
```

**Para los pagos.** Sin las tres, `/api/comprar` responde 503 y el botón de
compra queda apagado. El resto funciona igual.

```
WOMPI_PUBLIC_KEY
WOMPI_INTEGRITY_SECRET
WOMPI_EVENTS_SECRET
```

**Para el correo** (verificar cuentas nuevas y recuperar contraseña). Sin las
dos, las cuentas quedan verificadas de entrada como siempre (nadie se
bloquea), `/api/olvide-password` responde 503 y no se manda ningún correo.

```
RESEND_API_KEY
SMTP_FROM       Remitente, p.ej. "LunaticoIA <noreply@lunaticoia.uk>"
```

Se manda por la API HTTP de Resend (`api.resend.com`, puerto 443), no por su
relay SMTP: Railway bloquea el tráfico saliente por los puertos 25/465/587,
así que un envío por SMTP se queda intentando conectar hasta agotar el tiempo
de espera aunque las credenciales sean correctas. Confirmado a mano desde la
consola de Railway: `smtp.resend.com` no respondía en ningún puerto SMTP,
pero `api.resend.com:443` sí.

En Railway, editar una variable **no basta**: hay que pulsar **Deploy** o el
cambio se queda pendiente.

---

## Cómo se cobra

En los cuatro modelos de Claude la salida cuesta exactamente cinco veces lo
que la entrada, así que una sola fórmula sirve para todos:

```
facturables = tokens_entrada + (5 × tokens_salida)
1 crédito   = 1.000 facturables
cobro       = (facturables / 1.000) × multiplicador_del_modelo
```

| Modo | Modelo | Precio de entrada (oficial) | Multiplicador |
|---|---|---|---|
| Rápido | `claude-haiku-4-5-20251001` | $1 / MTok | ×1 |
| Equilibrado | `claude-sonnet-5` | $2 / MTok | ×3 |
| Avanzado | `claude-opus-5` | $5 / MTok | ×5 |
| Máximo | `claude-fable-5` | $10 / MTok | ×10 |

Los multiplicadores siguen la proporción de precios de entrada tomando Rápido
como base (×1 por cada $1/MTok), así que **el margen es idéntico use el
usuario el modelo que use** — con una excepción: **Equilibrado quedó en ×3
desde antes de que Sonnet bajara de precio** (a $2/MTok le tocaría ×2). No se
corrigió al agregar Máximo porque bajarlo cambiaría el cobro de cuentas que ya
vienen usándolo; si se ajusta algún día, que sea a propósito y no de paso.

El cobro ocurre **después** de una respuesta correcta. Si la API falla, no se
descuenta saldo.

### Herramientas de la IA

Cada respuesta se pide a Claude con tres herramientas activas (`HERRAMIENTAS_IA`
en `server-saas.js`), todas ejecutadas del lado de Anthropic — este servidor
nunca abre una URL ni corre código:

- `web_search` (`web_search_20250305`) — busca en internet. Cuesta **10
  créditos por búsqueda**, aparte de los tokens ($10 cada 1.000 búsquedas es
  el precio real de Anthropic).
- `web_fetch` (`web_fetch_20250910`) — abre y lee el contenido de una URL
  puntual. Solo puede abrir URLs que ya aparecieron antes en la conversación
  (las escribió el usuario o las trajo una búsqueda), nunca una que Claude
  invente. No cobra nada aparte de los tokens que consume el contenido leído.
- `code_execution` (`code_execution_20250825`) — corre Python/Bash en un
  sandbox de Anthropic sin acceso a internet. No cobra nada aparte de los
  tokens salvo que se agote el cupo mensual de horas gratis de la
  organización (1.550 horas, muy por encima de lo que un chat como este va a
  usar).

Como la respuesta ahora puede traer varios bloques de texto intercalados con
los de búsqueda/lectura/código (p.ej. "voy a buscar…" + resultados + la
respuesta final), `/api/chat` los junta todos — quedarse solo con el primero
(como hacía antes) cortaría la respuesta a la mitad.

### El modelo confundía su sandbox con el computador del usuario

Caso real: alguien le pidió una página web, la IA la "creó" con
`code_execution` y afirmó con total seguridad que ya la había exportado a la
carpeta de Descargas del usuario ("¡PERFECTO! ✅ Ahora deberías ver el
archivo... en tus Descargas"). No había nada ahí, por supuesto: el sandbox de
`code_execution` es un contenedor aislado de Anthropic sin ningún acceso al
dispositivo de quien escribe — nada de lo que el modelo guarde ahí puede
llegar jamás a la computadora de nadie.

`/api/chat` no tenía ningún `system` prompt, así que el modelo no tenía forma
de saber esto y lo inventó con confianza. Ahora manda `SYSTEM_PROMPT` (en
`server-saas.js`) explicando la separación entre el sandbox y el dispositivo
del usuario, y dejando claro que la única forma de "entregar" un archivo es
escribiendo su contenido completo en la respuesta (en un bloque de código)
para que la persona lo copie y lo guarde ella misma — nunca afirmar haberlo
guardado, exportado o descargado en su equipo.

### Respuestas cortadas (`stop_reason`)

`MAX_TOKENS_RESPUESTA` subió de 1.024 a 4.096 (por lo del punto anterior) y
después a **16.384**, tras un caso real: pidiendo crear una página completa
con `code_execution`, la respuesta se cortó justo en 4.096 tokens de salida
a mitad de la generación — el usuario veía "¡Aquí voy!" y después nada, sin
ninguna pista de si seguía trabajando o se había quedado pegada.

Ahora `/api/chat` revisa `response.stop_reason`: si es `max_tokens` (se
acabó el espacio) o `pause_turn` (Anthropic pausó una búsqueda/ejecución
larga a mitad de camino), se le agrega al final de la respuesta un aviso
explícito («⚠️ La respuesta se cortó… Escribe "continúa"…») en vez de
dejarla a medias en silencio. `consumo.cortada` también viaja al frontend
como booleano por si en algún momento conviene destacarlo visualmente.
Ojo: un "continúa" no retoma la tarea pausada tal cual la dejó Anthropic —
el modelo simplemente la vuelve a intentar con el contexto que tiene en el
historial, que en la práctica funciona bien casi siempre.

### Archivos adjuntos (imagen, PDF, texto/código)

`/api/chat` acepta tres campos opcionales, uno a la vez:

- `imagen: {mediaType, datos}` — JPEG, PNG, GIF o WEBP en base64, hasta 10MB
  (límite real de la API de Claude). Va como bloque `image`.
- `documento: {mediaType: 'application/pdf', datos, nombre}` — PDF en base64,
  hasta ~15MB. Va como bloque `document` nativo: Claude lo lee de verdad
  (texto, tablas, hasta páginas escaneadas), no es solo un adjunto ciego.
- `archivoTexto: {contenido, nombre}` — cualquier archivo de texto/código de
  la lista blanca en `EXTENSIONES_TEXTO_PERMITIDAS` (`.txt`, `.md`, `.js`,
  `.py`, `.json`, etc.), hasta 120.000 caracteres. No hay bloque nativo para
  esto en la API, así que se pega tal cual dentro del mensaje, envuelto en un
  bloque de código con el nombre del archivo delante.

**Word, Excel y `.zip` quedan fuera a propósito**: la API de Claude no tiene
un bloque nativo para binarios de Office ni para archivos comprimidos, y
convertirlos del lado del servidor (con alguna librería) es una pieza mucho
más grande que no se justificaba para esta primera versión.

Todos van **antes** del texto en el mensaje (mejor resultado, según la propia
guía de Anthropic), sin pasar por la Files API — más simple, sin archivos que
limpiar después. El límite del body de Express subió a 25mb para que quepa un
PDF en base64. El costo ya lo cubre la fórmula normal de créditos (todo se
factura como tokens de entrada); ninguno tiene cargo aparte.

**Los adjuntos SÍ quedan en el historial.** Antes solo se guardaba un
`[imagen adjunta] ` de texto y la imagen se perdía en el siguiente turno.
Ahora `messages.insertOne` guarda el mismo `content` que se le mandó a
Claude (bloques de imagen/documento incluidos), así que mientras el turno
siga dentro de la ventana de `MENSAJES_DE_HISTORIAL`, Claude lo sigue
"viendo" en los mensajes siguientes de la misma conversación. Contrapartida
conocida: la base de datos crece con el base64 de cada adjunto en vez de
quedarse solo con texto — aceptable para esta primera versión, pero si el
volumen de adjuntos crece mucho, tocaría migrar a la Files API de Anthropic
(subir una vez, guardar el `file_id`) en vez de guardar el binario cada vez.

### Memoria de la conversación

`MENSAJES_DE_HISTORIAL` subió de 10 a **30** mensajes de contexto. En 10, una
charla un poco larga "olvidaba" el principio; en 30 aguanta bastante más
antes de perder contexto. El costo en tokens (y por lo tanto en créditos) de
mandar más historial lo paga cada quien vía su propio saldo, así que subirlo
no le cuesta nada a la cuenta de LunaticoIA.

### Instrucciones personalizadas

Desde "Mi cuenta" cada usuario puede guardar sus propias instrucciones (tono,
idioma, qué tan detallada quiere la respuesta, etc.) vía
`POST /api/instrucciones` — hasta 600 caracteres, se guardan en
`user.instrucciones`. `construirSystemPrompt(user)` las pega al final de
`SYSTEM_PROMPT_BASE` en cada llamada a Claude; nunca lo reemplazan, así que
las reglas de seguridad de arriba (lo del sandbox de `code_execution`) siempre
se respetan aunque alguien intente escribir instrucciones que las contradigan.

### `/api/chat` responde en streaming (Server-Sent Events)

Antes se esperaba a que Claude terminara toda la respuesta y se mandaba de
un solo golpe con `res.json(...)`. Ahora `/api/chat` usa
`claudeClient.messages.stream(...)` (en vez de `.create(...)`) y responde con
`Content-Type: text/event-stream`: el texto llega en pedazos, en el orden en
que Claude lo va generando, y el frontend lo va mostrando a medida que llega
en vez de mostrar el indicador de "Pensando" hasta que todo esté listo.

Cada pedazo es una línea `data: {...}\n\n` con un campo `tipo`:

- `{tipo:'delta', texto:'...'}` — un pedazo nuevo de texto.
- `{tipo:'fin', response:'...', consumo:{...}}` — la respuesta completa y el
  mismo objeto `consumo` que antes iba en el único `res.json(...)`.
- `{tipo:'error', mensaje:'...'}` — algo falló (ver el punto siguiente).

**Consecuencia importante: el código HTTP 200 sale ANTES de saber si Claude
va a responder bien.** Con streaming no hay forma de "esperar a ver si
funciona" antes de comprometerse a un código de estado — en el momento en
que empieza a salir el primer byte, el código ya tiene que estar decidido.
Por eso:

- Los rechazos que se detectan ANTES de llamar a Claude (sin créditos → 402,
  modelo inválido → 400, correo sin verificar → 403, etc.) siguen siendo
  códigos HTTP normales con JSON, exactamente como antes — nada cambió ahí.
- Pero si Claude falla DESPUÉS de haber empezado el stream (API caída, clave
  inválida, lo que sea), la respuesta ya salió como `200 text/event-stream`
  y el error se manda como un evento `{tipo:'error'}` dentro del stream, no
  como un código 500. `fallo()` en `server-saas.js` revisa `res.headersSent`
  para saber cuál de las dos formas usar.
- **Esto rompió una prueba existente** (`pruebas/test-creditos.js`, "Si la
  API de Claude falla, NO se descuenta saldo"): antes esperaba `HTTP 500`,
  ahora espera `HTTP 200` con un evento `{tipo:'error'}` en el cuerpo. Si se
  toca esa prueba de nuevo, ojo con esto — no es un bug, es como tiene que
  comportarse un stream de verdad.

El resto del flujo (cobrar créditos, guardar en el historial, detectar
`stop_reason` cortado) sigue pasando exactamente en el mismo punto que
antes, solo que ahora es el último evento (`fin`) el que lo carga en vez de
la única respuesta JSON.

### Botón de descargar código

Cada bloque de código en una respuesta trae dos botones: "Copiar" (ya
existía) y "Descargar", que arma un `Blob` en el navegador y lo baja como
archivo — todo del lado del cliente, no pasa por el servidor. La extensión
del archivo sale del lenguaje que puso el modelo después de los ```` ``` ````
(`EXTENSION_POR_LENGUAJE` en `index.html`); si no lo reconoce, cae a `.txt`.

### Voz (dictado y lectura en voz alta)

Usa la Web Speech API nativa del navegador — **gratis, sin cuenta ni API key
de nadie**, por eso se implementó sin preguntar. Dos partes independientes:

- **Dictado** (botón de micrófono junto al clip): usa
  `SpeechRecognition`/`webkitSpeechRecognition` para transcribir y meter el
  texto en el campo de mensaje. Si el navegador no lo soporta (Firefox, la
  mayoría de Safari), el botón se esconde solo — no rompe nada.
- **Leer en voz alta** (botón que aparece bajo cada respuesta de la IA): usa
  `speechSynthesis`. Antes de leer, reemplaza los bloques de código por
  "bloque de código" para no leer código en voz alta línea por línea.

Ambas funcionan mejor en Chrome/Edge; el resto de navegadores puede no tener
una u otra, y la interfaz se adapta sola sin mostrar errores.

---

## Endpoints

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/api/health` | Estado del servicio |
| `POST` | `/api/register` | `{name, email, password}` · 5 por hora e IP |
| `POST` | `/api/login` | `{email, password}` · 20 cada 15 min e IP |
| `GET` | `/api/stats` | Saldo, modos disponibles e instrucciones personalizadas · requiere token |
| `POST` | `/api/instrucciones` | `{instrucciones}` · máx. 600 caracteres · se pegan al system prompt de cada chat |
| `POST` | `/api/chat` | `{message, modelo, imagen?, documento?, archivoTexto?}` · 20 por minuto · 402 si no hay saldo |
| `GET` | `/api/paquetes` | Catálogo, público |
| `POST` | `/api/comprar` | `{paquete}` · devuelve la firma para el checkout |
| `POST` | `/api/webhook` | Wompi · verifica firma, idempotente |
| `GET` | `/api/verificar-correo` | `?token=...` · lo abre el enlace del correo, redirige a `/` |
| `POST` | `/api/reenviar-verificacion` | Requiere token · 3 cada 15 min |
| `POST` | `/api/olvide-password` | `{email}` · 5 cada 15 min · siempre responde igual, exista o no la cuenta |
| `POST` | `/api/resetear-password` | `{token, password}` · 5 cada 15 min |

---

## Las pruebas

Necesitan `playwright` además de las dependencias normales:

```bash
npm install
npm install --no-save playwright
```

Se ejecutan **desde la raíz del proyecto**, sin copiar ni renombrar nada: cada
una carga `../server-saas.js` directamente.

Ninguna toca producción ni necesita MongoDB: usan un doble de la base
(`fake-mongo.js`) y un doble del SDK de Anthropic, inyectados en
`require.cache` antes de cargar el servidor.

```bash
node pruebas/test-creditos.js                  # 19 pruebas de la API
node pruebas/prueba-web.js                     # 18 del recorrido completo con navegador
node pruebas/auditar-accesibilidad.js          # contraste WCAG y lectores de pantalla
node pruebas/auditar-foco-y-red.js             # foco del teclado, caída de red, doble envío
node pruebas/auditar-errores-y-pestanas.js     # fuga de errores, dos pestañas, alto en móvil
```

**Corren en cualquier sistema.** `pruebas/entorno.js` resuelve las dos cosas
que antes estaban escritas a mano para Linux: usa el chromium del contenedor
si existe y si no deja que Playwright busque el suyo, y guarda las capturas en
`pruebas/capturas/` en vez de en una ruta absoluta.

**Ninguna prueba define `RESEND_API_KEY`**, así que corren con el correo
apagado: las cuentas nacen verificadas y el filtro de `/api/chat` no se activa.
Si algún día se añade esa variable al entorno de pruebas, los casos de chat
empezarán a dar 403 hasta que el guion verifique la cuenta primero. No está
roto: es que el filtro hace su trabajo.

---

## Cosas que conviene no romper

**El orden importa en el webhook de Stripe, no en el de Wompi.** Stripe firma
el cuerpo crudo, así que su ruta tenía que ir antes de `express.json()`. Wompi
firma valores de campos, no el cuerpo, así que da igual. Si algún día vuelves a
Stripe, recuérdalo: es un fallo silencioso y muy difícil de ver.

**El webhook es idempotente a propósito.** Wompi reintenta los eventos. La
compra se marca aprobada con una escritura condicional, así que un reintento no
abona los créditos dos veces.

**El nombre de la base va fijo en el código** (`client.db('lunatico_ia')`), así
que lo que traiga la URI después del host es indiferente. Eso hace que cambiar
a MongoDB Atlas sea solo cambiar `MONGODB_URI`.

**No devuelvas `error.message` al cliente.** Usa el helper `fallo()`. El detalle
va al log; al usuario, un mensaje que pueda entender.

**`justify-content: flex-end` en un contenedor con scroll** deja inalcanzable lo
que desborda por arriba. Para anclar contenido abajo, `margin-top: auto` en el
hijo.

**El correo sigue el mismo patrón que Wompi: se apaga solo si falta config.**
`CORREO_CONFIGURADO` decide todo. Sin `RESEND_API_KEY`, las cuentas nuevas
nacen `emailVerified: true` y las viejas se migran igual (`asegurarVerificado`,
calco de `asegurarSaldo`) — nadie queda bloqueado por accidente el día que se
despliegue esto sin haber configurado el correo todavía.

**El correo se manda por la API HTTP de Resend, no por su relay SMTP.**
Railway bloquea el tráfico saliente por los puertos 25/465/587, así que con
nodemailer + `smtp.resend.com` cada envío se quedaba esperando la conexión
hasta hacer timeout — con las credenciales correctas y todo. La API HTTP usa
el puerto 443, que sí está abierto. Se llama con el módulo `https` nativo
(`llamarResendAPI()`) en vez del paquete `resend`, porque ese paquete pide
Node 20 y aquí se corre Node 14 (ver "Lo que falta").

**El correo nunca debe tumbar una petición.** `enviarCorreo()` atrapa sus
propios errores y devuelve `false`; si Resend falla, el registro o la
recuperación igual responden bien. Si alguna vez se necesita saber si el
correo salió, hay que leerlo del valor de retorno, no de una excepción.

**`/api/olvide-password` responde lo mismo exista o no la cuenta.** Es
deliberado, para no dejar que alguien confirme qué correos están registrados
probando uno por uno.

**El gate de correo verificado solo está en `/api/chat`.** Registrarse, entrar
y comprar créditos funcionan igual sin verificar — es la única acción con
costo real (llamar a Claude) la que se frena, para no trabar a alguien que ya
va a pagar.

---

## Lo que falta

1. Que Wompi cambie el nombre del comercio a **LunaticoIA** (quedó
   «interrapidisimo» por error).
2. Averiguar por qué rechazaron la cuenta bancaria de payouts. Puede ser el
   mismo problema que el del nombre del comercio.
3. Poner las tres llaves de Wompi y configurar el webhook.
4. Un pago de prueba de punta a punta.

~~5. Poner `RESEND_API_KEY` en Railway~~ — hecho: el correo (verificación de
cuenta y recuperación de contraseña) está activo en producción desde el
24 de agosto de 2026, usando la API HTTP de Resend.

~~6. Streaming de respuestas~~ — hecho: `/api/chat` responde en Server-Sent
Events, ver "`/api/chat` responde en streaming" más arriba.

Y sin prisa: respaldos de la base, alojar las tipografías en el servidor, subir
de Node 14 a Node 20, e historial de conversaciones.
