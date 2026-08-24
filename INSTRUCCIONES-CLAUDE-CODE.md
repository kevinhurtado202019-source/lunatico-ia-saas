# Encargo para Claude Code

Este archivo lo escribió otra sesión de Claude (en la nube) que pudo leer y
escribir archivos en este equipo pero **no ejecutar comandos**. Todo lo que
sigue está verificado leyendo los archivos reales; lo que es sospecha está
marcado como tal.

Kevin quiere que esto se resuelva sin tener que ir paso a paso. Avanza hasta
donde puedas solo. Párate únicamente si hace falta una contraseña o una
decisión de negocio.

---

## Qué es esto

LunaticoIA: chat de IA con créditos prepago, pagos por Wompi (Colombia).
Node + Express + MongoDB, frontend en un solo `index.html`. Desplegado en
Railway, en línea y funcionando: https://lunatico-ia-saas-production.up.railway.app

- `server-saas.js` — backend completo
- `index.html` — landing + acceso + app, todo junto
- `pruebas/` — 5 baterías, sin tocar producción (usan dobles de Mongo y del SDK)
- `LEEME.md` — la documentación real del proyecto. **Léela antes que nada.**

---

## Lo urgente

### 1. Esta carpeta no está bajo control de versiones

No hay `.git` aquí. El código que sostiene el negocio existe en una sola
carpeta de OneDrive, sin respaldo ni historial. Es el riesgo más grande hoy.

Hay un `HACER-TODO.bat` que hace `npm install` + `git init` + primer commit.
Puedes ejecutar esos comandos tú directamente, no hace falta el .bat.

### 2. El repo de GitHub NO tiene el código que está en producción

Verificado: `https://github.com/kevinhurtado202019-source/lunatico-ia-saas`
contiene una versión **vieja**, con Stripe y planes FREE/PRO/ENTERPRISE. Ni
rastro de Wompi ni de créditos.

Hay otra carpeta, `C:\portafolio-ia`, que **sí** es un clon de ese repo y
contiene esa versión vieja. Su reflog muestra 3 commits, el último pusheado
~31 h antes de que se escribiera el código de créditos que está aquí.

**Entonces nadie sabe cómo llega el código a Railway.** Hipótesis a comprobar,
en orden de probabilidad:

1. Railway despliega desde otro repositorio.
2. Se subió con `railway up` (CLI), que sube la carpeta local sin pasar por git.
3. Se editó a mano en la interfaz de Railway.

Averígualo (`railway status` / `railway link`, o la web: proyecto → servicio →
Settings → Source). Según lo que salga:

- **Si hay un repo distinto**: clónalo, compara con esta carpeta, y deja esta
  como copia de trabajo conectada a ese remoto.
- **Si es CLI**: propón conectar un repo de GitHub para que el deploy sea
  automático y quede historial. Es la corrección de fondo.
- **En cualquier caso**: `C:\portafolio-ia` está obsoleta y confunde. Cuando
  esté claro cuál es la buena, conviene archivarla o borrarla — pero pregunta
  antes, no la borres por tu cuenta.

### 3. Wompi está sin configurar y eso cuesta dinero

Los pagos no funcionan: faltan `WOMPI_PUBLIC_KEY`, `WOMPI_INTEGRITY_SECRET` y
`WOMPI_EVENTS_SECRET` en Railway. Mientras tanto cada usuario nuevo gasta
créditos de regalo que se pagan con la API de Anthropic, sin forma de cobrar.

Hay dos trámites pendientes con Wompi (nombre del comercio mal puesto, cuenta
de payouts rechazada) — ver `LEEME.md` y `mensaje-soporte-wompi.txt`. **Eso lo
tiene que hacer Kevin**, es su identidad y su cuenta bancaria. No lo intentes.

---

## Lo que se cambió hoy y está sin desplegar

Se añadió **verificación de correo** y **recuperación de contraseña**.

Diseño clave: siguen el mismo patrón que Wompi — **si no hay SMTP configurado,
la funcionalidad se apaga sola**. `CORREO_CONFIGURADO` gobierna todo. Sin
`SMTP_HOST` / `SMTP_USER` / `SMTP_PASS`, las cuentas nacen verificadas y nada
cambia respecto a lo que hay hoy en producción. Se puede desplegar sin miedo
antes de tener el SMTP.

- `asegurarVerificado()` migra usuarios viejos (calco de `asegurarSaldo()`).
- El filtro de correo verificado está **solo** en `/api/chat`: registrarse,
  entrar y comprar funcionan sin verificar.
- `/api/olvide-password` responde igual exista o no la cuenta, a propósito.
- Endpoints nuevos y variables: documentados en `LEEME.md`.

Falta: `npm install` (se añadió `nodemailer` a `package.json` pero no hay
`package-lock.json` ni `node_modules` aquí).

### Verificación

Las pruebas se revisaron a mano contra los cambios pero **nunca se ejecutaron**
— la sesión que las escribió no tenía shell ni acceso a npm. Ejecútalas:

```
node pruebas/test-creditos.js
node pruebas/prueba-web.js
node pruebas/auditar-accesibilidad.js
node pruebas/auditar-foco-y-red.js
node pruebas/auditar-errores-y-pestanas.js
```

Las de navegador necesitan `npm install --no-save playwright`.

Se corrigieron hoy para que corran en Windows (antes tenían rutas de Linux
escritas a mano): ver `pruebas/entorno.js`. Ninguna prueba define `SMTP_*`, así
que corren con el correo apagado y el filtro de `/api/chat` no se activa. Eso
es intencional.

---

## Prioridad sugerida

1. `npm install` y dejar esta carpeta en git con un primer commit.
2. Ejecutar las pruebas y reportar qué pasa. Si algo falla, arreglarlo.
3. Averiguar el origen real del deploy y dejarlo conectado a un repo.
4. Subir el código nuevo y confirmar el redespliegue.
5. Solo entonces: variables `SMTP_*` en Railway para encender la verificación.

Pendientes menores anotados en `LEEME.md`: Node 14 → 20, revocación de tokens
JWT, CSP en Helmet, respaldos de la base.

**No rompas** lo que `LEEME.md` marca en "Cosas que conviene no romper". Está
escrito por alguien que ya se tropezó con cada una.
