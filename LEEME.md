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
(como hacía antes) cortaría la respuesta a la mitad. `MAX_TOKENS_RESPUESTA`
también subió de 1.024 a 4.096 por la misma razón.

---

## Endpoints

| Método | Ruta | Notas |
|---|---|---|
| `GET` | `/api/health` | Estado del servicio |
| `POST` | `/api/register` | `{name, email, password}` · 5 por hora e IP |
| `POST` | `/api/login` | `{email, password}` · 20 cada 15 min e IP |
| `GET` | `/api/stats` | Saldo y modos disponibles · requiere token |
| `POST` | `/api/chat` | `{message, modelo}` · 20 por minuto · 402 si no hay saldo |
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

Y sin prisa: respaldos de la base, alojar las tipografías en el servidor, subir
de Node 14 a Node 20, e historial de conversaciones.
