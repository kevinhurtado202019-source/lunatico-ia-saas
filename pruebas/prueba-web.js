// Arranca el servidor real (con base simulada) sirviendo el index.html nuevo,
// y recorre la web con un navegador de verdad: registro, chat y paquetes.
const http = require('http');

const fake = require('./fake-mongo');
const realPath = require.resolve('mongodb');
require.cache[realPath] = { id: realPath, filename: realPath, loaded: true, exports: fake, paths: [] };

const PORT = 4711;
process.env.MONGODB_URI = 'mongodb://fake/lunatico';
process.env.JWT_SECRET = 'secreto-de-prueba';
process.env.CLAUDE_API_KEY = 'clave-falsa';
process.env.WOMPI_PUBLIC_KEY = 'pub_test_falsa';
process.env.WOMPI_INTEGRITY_SECRET = 'integridad';
process.env.WOMPI_EVENTS_SECRET = 'eventos';
process.env.PORT = String(PORT);

// Doble del SDK de Anthropic: se inyecta ANTES de cargar el servidor para que
// el cliente que construye internamente sea el falso y no toque la API real.
function AnthropicFake(opts) {
    this.apiKey = opts && opts.apiKey;
    this.messages = {
        create: async function (params) {
            AnthropicFake.ultimaLlamada = params;
            return {
                id: 'msg_fake', type: 'message', role: 'assistant',
                model: params.model,
                content: [{ type: 'text', text: 'Respuesta simulada para la prueba.' }],
                usage: { input_tokens: 1600, output_tokens: 400 }
            };
        },
        // Doble minimo de MessageStream: registra el listener de 'text' y,
        // al pedir finalMessage(), lo dispara una vez con el texto completo
        // antes de resolver -- alcanza para probar el cableado SSE real
        // (server-saas.js solo usa .on('text', ...) y .finalMessage()).
        stream: function (params) {
            AnthropicFake.ultimaLlamada = params;
            const texto = 'Respuesta simulada para la prueba.';
            const finalMessage = {
                id: 'msg_fake', type: 'message', role: 'assistant',
                model: params.model,
                content: [{ type: 'text', text: texto }],
                usage: { input_tokens: 1600, output_tokens: 400 },
                stop_reason: 'end_turn'
            };
            const listeners = {};
            const streamFalso = {
                on: function (evento, cb) { listeners[evento] = cb; return streamFalso; },
                finalMessage: async function () {
                    if (listeners.text) listeners.text(texto, texto);
                    return finalMessage;
                }
            };
            return streamFalso;
        }
    };
}
AnthropicFake.default = AnthropicFake;
const sdkPath = require.resolve('@anthropic-ai/sdk');
require.cache[sdkPath] = {
    id: sdkPath, filename: sdkPath, loaded: true, exports: AnthropicFake, paths: []
};

require('../server-saas.js');

// Parchear el cliente ya construido es frágil; en su lugar interceptamos
// la capa HTTP del SDK sustituyendo global fetch para api.anthropic.com.
const realFetch = global.fetch;


const { chromium } = require('playwright');
const entorno = require('./entorno');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


async function recorrido() {
  const b = await chromium.launch(entorno.opcionesNavegador());
  const R = [];
  const ok = (n, c, d) => R.push({ n, ok: !!c, d });
  const paso = async (n, fn) => {
    try { const d = await fn(); ok(n, true, d); }
    catch (e) { ok(n, false, String(e.message || e).split('\n')[0].slice(0, 130)); }
  };

  const errores = [];
  const malas = [];
  const nueva = async (o) => {
    const pg = await b.newPage(o || { viewport: { width: 1366, height: 900 } });
    pg.on('pageerror', e => errores.push('pageerror: ' + e.message));
    pg.on('console', m => { if (m.type() === 'error' && !/favicon/i.test(m.text()) && !/status of 403/.test(m.text())) errores.push('console: ' + m.text()); });
    pg.on('response', r => {
      if (r.status() >= 400 && !(r.status() === 403 && /\/api\/stats/.test(r.url()))) {
        malas.push(r.status() + ' ' + r.url());
      }
    });
    return pg;
  };

  // ---------- VISITANTE NUEVO ----------
  let pg = await nueva();
  await pg.goto('http://127.0.0.1:4711/', { waitUntil: 'networkidle' });

  ok('Un visitante nuevo ve la landing, no el login', await pg.isVisible('#landing'));
  ok('El formulario de acceso está oculto al llegar', !(await pg.isVisible('#acceso')));

  await paso('El titular explica la propuesta', async () => {
    const h = (await pg.textContent('.hero h1')).replace(/\s+/g, ' ').trim();
    if (!/Nequi/.test(h)) throw new Error(h);
    return h;
  });

  await paso('Los botones no se estiran de lado a lado', async () => {
    const m = await pg.evaluate(() => {
      const anchoPag = document.querySelector('.lp').getBoundingClientRect().width;
      const b = [...document.querySelectorAll('.lp-nav .btn, .hero-botones .btn')]
        .filter(x => x.offsetParent !== null)
        .map(x => Math.round(x.getBoundingClientRect().width));
      return { anchoPag: Math.round(anchoPag), b };
    });
    const gordos = m.b.filter(w => w > m.anchoPag * 0.6);
    if (gordos.length) throw new Error('botones de ' + gordos.join(',') + 'px en un ancho de ' + m.anchoPag);
    return 'anchos ' + m.b.join(', ') + ' px';
  });

  await paso('Los dos botones del hero van en la misma linea', async () => {
    // El boton "Descargar app" arranca escondido (solo aparece si el
    // navegador dispara beforeinstallprompt), asi que se excluye de este
    // chequeo de alineacion -- no tiene sentido alinear algo que no se ve.
    const y = await pg.$$eval('.hero-botones .btn', e => e
      .filter(x => x.offsetParent !== null)
      .map(x => Math.round(x.getBoundingClientRect().top)));
    if (new Set(y).size !== 1) throw new Error('tops distintos: ' + y.join(','));
    return 'alineados';
  });

  await paso('Los tres pilares están', async () => {
    const t = await pg.$$eval('.pilar h3', e => e.map(x => x.textContent.trim()));
    if (t.length !== 3) throw new Error(t.length);
    return t.join(' | ');
  });

  await paso('Los precios se cargan desde la API', async () => {
    await pg.waitForSelector('#listaPrecios .plan', { timeout: 8000 });
    const n = await pg.$$eval('#listaPrecios .plan', e => e.length);
    const v = await pg.$$eval('#listaPrecios .valor', e => e.map(x => x.textContent.trim()));
    if (n !== 4) throw new Error(n + ' planes');
    return v.join(' ');
  });

  await paso('Los numeros grandes llevan separador de miles', async () => {
    const t = await pg.$$eval('#listaPrecios li', e => e.map(x => x.textContent.trim()));
    const feos = t.filter(x => /~\d{4,}/.test(x));
    if (feos.length) throw new Error(feos.join(' | '));
    return t.filter(x => /mensajes/.test(x)).join(' · ');
  });

  await paso('"Ver precios" lleva a la sección', async () => {
    await pg.click('text=Ver precios');
    await pg.waitForTimeout(900);
    const y = await pg.evaluate(() => document.getElementById('precios').getBoundingClientRect().top);
    if (y > 400) throw new Error('no bajó, top=' + Math.round(y));
    return 'top=' + Math.round(y);
  });

  await paso('El FAQ se abre', async () => {
    await pg.click('.faq summary >> nth=0');
    await pg.waitForTimeout(400);
    const abierto = await pg.$$eval('.faq details', e => e.filter(d => d.open).length);
    if (!abierto) throw new Error('no abrió');
    return abierto + ' abierto';
  });

  await paso('Sin scroll horizontal en la landing', async () => {
    const d = await pg.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (d) throw new Error('desborda');
    return 'ok';
  });

  // ---------- DE LA LANDING A LA CUENTA ----------
  const email = `visita-${Date.now()}@test.local`;
  await paso('Desde la landing se llega a crear cuenta y entra a la app', async () => {
    await pg.click('.lp-nav button.btn-luna');
    await pg.waitForTimeout(500);
    if (!(await pg.isVisible('#acceso'))) throw new Error('no abrió el acceso');
    if (!(await pg.isVisible('#formCrear'))) throw new Error('no mostró el formulario de registro');
    await pg.fill('#nombreCrear', 'Visitante');
    await pg.fill('#correoCrear', email);
    await pg.fill('#claveCrear', 'ClaveLarga123');
    await pg.click('#btnCrear');
    await pg.waitForTimeout(1800);
    if (!(await pg.isVisible('#app'))) throw new Error('no entró a la app');
    if (await pg.isVisible('#landing')) throw new Error('la landing sigue visible');
    return 'landing -> registro -> app';
  });

  await paso('El chat sigue funcionando tras el cambio', async () => {
    await pg.fill('#entrada', 'Hola');
    await pg.press('#entrada', 'Enter');
    await pg.waitForTimeout(2400);
    const t = await pg.$$eval('.turno.ia .texto', e => e.map(x => x.textContent.trim()));
    if (!t.some(x => x.includes('Respuesta simulada'))) throw new Error(t.join(' / ').slice(0, 90));
    const s = (await pg.textContent('#numSaldo')).trim();
    if (s !== '96') throw new Error('saldo=' + s);
    return 'responde y descuenta a 96';
  });

  await paso('Sin TWA, el panel de paquetes muestra "Comprar"', async () => {
    await pg.click('#chipSaldo');
    await pg.waitForTimeout(300);
    const hayBoton = await pg.isVisible('#cuerpoPanel button.btn-luna');
    await pg.click('#velo');
    if (!hayBoton) throw new Error('no aparecio el boton de comprar');
    return 'ok';
  });

  await paso('Con ?fuente=twa, no se puede comprar dentro de la app', async () => {
    // El token queda en localStorage: recargar con el parametro de arranque
    // del TWA entra directo a la app, sin pasar por el registro de nuevo.
    await pg.goto(`http://127.0.0.1:4711/?fuente=twa`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(800);
    if (!(await pg.isVisible('#app'))) throw new Error('no entro a la app con el token guardado');
    await pg.click('#chipSaldo');
    await pg.waitForTimeout(300);
    const hayBoton = await pg.isVisible('#cuerpoPanel button.btn-luna');
    const texto = await pg.textContent('#cuerpoPanel');
    if (hayBoton) throw new Error('el boton de comprar sigue visible dentro del TWA');
    if (!/lunaticoia\.uk/.test(texto)) throw new Error('no avisa donde comprar: ' + texto.slice(0, 150));
    return 'sin boton de comprar, avisa ir al navegador';
  });

  await paso('?fuente=apk apaga el esTWA aunque haya quedado pegado de antes', async () => {
    // Bug real: esTWA solo se prendia, nunca se apagaba -- alguien que abrio
    // el TWA una vez (o el primer build del APK, que traia ?fuente=twa) se
    // quedaba con el aviso de "no se puede comprar" pegado para siempre en
    // ese dispositivo, aunque despues abriera con el APK de verdad.
    await pg.goto(`http://127.0.0.1:4711/?fuente=apk`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(800);
    if (!(await pg.isVisible('#app'))) throw new Error('no entro a la app con el token guardado');
    await pg.click('#chipSaldo');
    await pg.waitForTimeout(300);
    const hayBoton = await pg.isVisible('#cuerpoPanel button.btn-luna');
    await pg.click('#velo');
    if (!hayBoton) throw new Error('el aviso de "no se puede comprar" quedo pegado con ?fuente=apk');
    return 'el boton de comprar vuelve a aparecer';
  });

  await paso('?fuente=pwa tambien apaga el esTWA (bug real reportado)', async () => {
    // Caso real: alguien probo el TWA en el navegador (o el primer build)
    // con ?fuente=twa, y despues instalo la PWA de siempre con el boton
    // "Descargar app" -- ese boton usa manifest.json > start_url, que es
    // ?fuente=pwa, no ?fuente=apk. Comparte el mismo Chrome (mismo
    // localStorage) que el navegador normal, asi que tambien tenia que
    // limpiar el esTWA pegado, y al principio no lo hacia.
    await pg.goto(`http://127.0.0.1:4711/?fuente=twa`, { waitUntil: 'networkidle' }); // deja esTWA pegado en 1 otra vez
    await pg.goto(`http://127.0.0.1:4711/?fuente=pwa`, { waitUntil: 'networkidle' });
    await pg.waitForTimeout(800);
    await pg.click('#chipSaldo');
    await pg.waitForTimeout(300);
    const hayBoton = await pg.isVisible('#cuerpoPanel button.btn-luna');
    await pg.click('#velo');
    if (!hayBoton) throw new Error('el aviso de "no se puede comprar" quedo pegado con ?fuente=pwa');
    return 'el boton de comprar vuelve a aparecer';
  });

  await pg.screenshot({ path: entorno.captura('lp-tras-registro.png') });
  await pg.close();

  // ---------- VOLVER CON SESION ABIERTA ----------
  await paso('Con sesión válida se entra directo a la app, sin landing', async () => {
    const p2 = await nueva();
    await p2.goto('http://127.0.0.1:4711/');
    const tok = await p2.evaluate(async () => {
      const r = await fetch('/api/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Vuelve', email: 'vuelve-' + Date.now() + '@t.local', password: 'ClaveLarga123' })
      });
      const d = await r.json();
      localStorage.setItem('authToken', d.token);
      return d.token;
    });
    await p2.goto('http://127.0.0.1:4711/', { waitUntil: 'networkidle' });
    await p2.waitForTimeout(1000);
    const verApp = await p2.isVisible('#app');
    const verLanding = await p2.isVisible('#landing');
    const saldo = await p2.textContent('#numSaldo').catch(() => '?');
    await p2.close();
    if (!verApp || verLanding) throw new Error('app=' + verApp + ' landing=' + verLanding);
    return 'app visible, saldo ' + saldo.trim();
  });

  await paso('Un token invalido devuelve al visitante a la landing', async () => {
    const p3 = await nueva();
    await p3.goto('http://127.0.0.1:4711/');
    await p3.evaluate(() => localStorage.setItem('authToken', 'token.invalido'));
    await p3.goto('http://127.0.0.1:4711/', { waitUntil: 'networkidle' });
    await p3.waitForTimeout(1400);
    const verLanding = await p3.isVisible('#landing');
    const quedaToken = await p3.evaluate(() => localStorage.getItem('authToken'));
    await p3.close();
    if (!verLanding) throw new Error('no volvio a la landing');
    if (quedaToken) throw new Error('el token invalido no se borro');
    return 'sesion limpiada y landing mostrada';
  });

  // ---------- LANDING EN MOVIL ----------
  await paso('La landing se ve bien en móvil', async () => {
    const pm = await nueva({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 });
    await pm.goto('http://127.0.0.1:4711/', { waitUntil: 'networkidle' });
    await pm.waitForSelector('#listaPrecios .plan', { timeout: 8000 });
    const d = await pm.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    await pm.screenshot({ path: entorno.captura('lp-movil.png'), fullPage: true });
    await pm.close();
    if (d) throw new Error('scroll horizontal');
    return 'sin desbordes';
  });

  // captura de escritorio limpia
  const pd = await nueva({ viewport: { width: 1366, height: 900 } });
  await pd.goto('http://127.0.0.1:4711/', { waitUntil: 'networkidle' });
  await pd.waitForSelector('#listaPrecios .plan', { timeout: 8000 });
  await pd.screenshot({ path: entorno.captura('lp-escritorio.png') });
  // #landing tiene su propio scroll, asi que fullPage no lo captura: recorro por secciones
  const secciones = [
    ['#precios', 'lp-precios'],
    ['.faq', 'lp-faq'],
    ['.cierre', 'lp-cierre']
  ];
  for (const [sel, nombre] of secciones) {
    await pd.evaluate((q) => document.querySelector(q).scrollIntoView({ block: 'start' }), sel);
    await pd.waitForTimeout(600);
    await pd.screenshot({ path: entorno.captura(nombre + '.png') });
  }
  await pd.close();

  ok('Sin errores de JavaScript', errores.length === 0, errores.slice(0, 2).join(' ;; ') || 'ninguno');
  ok('Sin respuestas HTTP con error', malas.length === 0, malas.slice(0, 2).join(' | ') || 'ninguna');

  const pass = R.filter(r => r.ok).length;
  console.log('\n====================================================');
  console.log(`  LANDING + APP: ${pass}/${R.length}`);
  console.log('====================================================');
  for (const r of R) console.log(`${r.ok ? '  OK    ' : '  FALLA '} ${r.n}${r.d ? '   [' + r.d + ']' : ''}`);
  console.log('');
  await b.close();
  return pass === R.length;
}

(async () => {
    for (let i = 0; i < 80; i++) {
        try {
            const r = await realFetch(`http://127.0.0.1:${PORT}/api/health`);
            if (r.status === 200) break;
        } catch (e) {}
        await sleep(200);
    }
    let bien = false;
    try { bien = await recorrido(); }
    catch (e) { console.error('ERROR EN EL RECORRIDO:', e.message); }
    process.exit(bien ? 0 : 1);
})();
