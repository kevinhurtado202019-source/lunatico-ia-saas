// Prueba el aviso de saldo bajo: que se mande justo al CRUZAR el umbral
// hacia abajo, que no se repita en el siguiente mensaje (todavia por debajo),
// y que la verificacion de correo real (Resend) tambien pase por este mismo
// doble -- asi se prueba el flujo completo, no solo el aviso suelto.
const http = require('http');

const fake = require('./fake-mongo');
const realMongoPath = require.resolve('mongodb');
require.cache[realMongoPath] = { id: realMongoPath, filename: realMongoPath, loaded: true, exports: fake, paths: [] };

// Doble de MessageStream: usage fijo (1000 entrada / 1000 salida) para que
// cada mensaje cobre siempre lo mismo -- en Rapido (multiplicador x1):
// facturables = 1000 + 5*1000 = 6000 -> 6 creditos por mensaje, exacto.
function AnthropicFake() {
    this.messages = {
        stream: function (params) {
            const texto = 'Respuesta simulada.';
            const finalMessage = {
                content: [{ type: 'text', text: texto }],
                usage: { input_tokens: 1000, output_tokens: 1000 },
                stop_reason: 'end_turn',
                model: params.model
            };
            const listeners = {};
            const streamFalso = {
                on: function (ev, cb) { listeners[ev] = cb; return streamFalso; },
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
require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: AnthropicFake, paths: [] };

// Doble de la API HTTP de Resend: intercepta lo que server-saas.js le manda
// a api.resend.com con el modulo https nativo, sin tocar la red real.
const correosEnviados = [];
const EventEmitter = require('events');
const httpsPath = require.resolve('https');
const httpsReal = require(httpsPath);
const httpsFake = Object.assign({}, httpsReal, {
    request(options, callback) {
        let cuerpo = '';
        const reqFalsa = {
            on() { return reqFalsa; },
            write(chunk) { cuerpo += chunk; return true; },
            end() {
                if (options.hostname === 'api.resend.com') {
                    correosEnviados.push(JSON.parse(cuerpo));
                }
                const resFalsa = new EventEmitter();
                resFalsa.statusCode = 200;
                setImmediate(() => {
                    callback(resFalsa);
                    setImmediate(() => { resFalsa.emit('data', '{"id":"fake"}'); resFalsa.emit('end'); });
                });
            }
        };
        return reqFalsa;
    }
});
require.cache[httpsPath] = { id: httpsPath, filename: httpsPath, loaded: true, exports: httpsFake, paths: [] };

const PORT = 4917;
const BASE = `http://127.0.0.1:${PORT}`;
process.env.MONGODB_URI = 'mongodb://fake/lunatico';
process.env.JWT_SECRET = 'secreto-de-prueba';
process.env.CLAUDE_API_KEY = 'clave-falsa';
process.env.RESEND_API_KEY = 'resend-de-prueba';
process.env.SMTP_FROM = 'LunaticoIA <noreply@lunaticoia.uk>';
process.env.PORT = String(PORT);

function req(method, p, body, headers) {
    return new Promise((resolve) => {
        const data = body === undefined || body === null ? null : JSON.stringify(body);
        const h = Object.assign({}, headers || {});
        if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
        const r = http.request(BASE + p, { method, headers: h }, (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        });
        r.on('error', (e) => resolve({ status: 0, body: String(e) }));
        if (data) r.write(data);
        r.end();
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    require('../server-saas.js');

    const R = [];
    const check = (n, ok, d) => R.push({ n, ok: !!ok, d });

    let up = false;
    for (let i = 0; i < 60; i++) {
        if ((await req('GET', '/api/health')).status === 200) { up = true; break; }
        await sleep(200);
    }
    check('El servidor arranca', up);
    if (!up) { console.log('no arrancó'); process.exit(1); }

    const db = fake.getDb();
    const users = db.collection('users');

    // --- Registro real, con correo encendido ---
    const email = `saldo-bajo-${Date.now()}@test.local`;
    const reg = await req('POST', '/api/register', { name: 'Prueba', email, password: 'Clave123!' });
    const regBody = JSON.parse(reg.body);
    check('Con correo encendido, la cuenta nace SIN verificar',
        reg.status === 200 && regBody.user.emailVerified === false, JSON.stringify(regBody.user));
    check('Se manda un correo de verificación real (por el doble de Resend)',
        correosEnviados.length === 1 && /Confirma tu correo/.test(correosEnviados[0].subject),
        'enviados=' + correosEnviados.length);

    // --- Verificar de verdad, extrayendo el link del cuerpo del correo ---
    const linkVerificacion = (correosEnviados[0].text.match(/https?:\/\/\S+/) || [])[0];
    const tokenVerificacion = linkVerificacion && new URL(linkVerificacion).searchParams.get('token');
    check('El correo trae un link de verificación con token', Boolean(tokenVerificacion));
    const verif = await req('GET', `/api/verificar-correo?token=${tokenVerificacion}`);
    check('El enlace verifica la cuenta (redirige a ?verificacion=ok)',
        verif.status === 302 && /verificacion=ok/.test(verif.body), 'HTTP ' + verif.status + ' ' + verif.body.slice(0, 80));

    const tok = regBody.token;

    // --- Deja el saldo justo arriba del umbral (30) para forzar el cruce ---
    await users.updateOne({ email }, { $set: { creditBalance: 35 } });
    correosEnviados.length = 0; // el de verificación ya se probó, no estorbe lo que sigue

    // --- Primer mensaje: 35 -> 29, CRUZA el umbral -> debe avisar ---
    await req('POST', '/api/chat', { message: 'hola' }, { Authorization: 'Bearer ' + tok });
    await sleep(300);
    const usuarioTrasCruzar = await users.findOne({ email });
    check('El saldo bajó a 29 tras el primer mensaje', usuarioTrasCruzar.creditBalance === 29,
        'saldo=' + usuarioTrasCruzar.creditBalance);
    check('Se manda el aviso de saldo bajo al cruzar el umbral',
        correosEnviados.length === 1 && /acabando los créditos/.test(correosEnviados[0].subject) &&
        correosEnviados[0].to === email,
        'enviados=' + correosEnviados.length);

    // --- Segundo mensaje: 29 -> 23, sigue bajo pero YA estaba bajo antes ---
    correosEnviados.length = 0;
    await req('POST', '/api/chat', { message: 'hola de nuevo' }, { Authorization: 'Bearer ' + tok });
    await sleep(300);
    const usuarioTrasSegundo = await users.findOne({ email });
    check('El saldo sigue bajando (29 -> 23)', usuarioTrasSegundo.creditBalance === 23,
        'saldo=' + usuarioTrasSegundo.creditBalance);
    check('NO se repite el aviso: ya estaba por debajo del umbral, no hay cruce nuevo',
        correosEnviados.length === 0, 'enviados=' + correosEnviados.length);

    // --- Si compra y vuelve a bajar del umbral, avisa de nuevo ---
    await users.updateOne({ email }, { $set: { creditBalance: 32 } }); // simula una compra
    await req('POST', '/api/chat', { message: 'otra vez' }, { Authorization: 'Bearer ' + tok });
    await sleep(300);
    check('Tras comprar y volver a cruzar el umbral, avisa otra vez',
        correosEnviados.length === 1, 'enviados=' + correosEnviados.length);

    const pass = R.filter((r) => r.ok).length;
    console.log('\n=================================================');
    console.log(`  AVISO DE SALDO BAJO: ${pass}/${R.length}`);
    console.log('=================================================');
    for (const r of R) console.log(`${r.ok ? '  OK    ' : '  FALLA '} ${r.n}${r.d ? '   [' + r.d + ']' : ''}`);
    console.log('');
    process.exit(pass === R.length ? 0 : 1);
})();
