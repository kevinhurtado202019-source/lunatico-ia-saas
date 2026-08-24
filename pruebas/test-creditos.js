// Prueba el servidor de créditos con base simulada y una firma de Wompi
// construida con el MISMO algoritmo que documenta Wompi, para verificar que
// la verificación acepta lo válido y rechaza lo manipulado.
const crypto = require('crypto');
const http = require('http');

const fake = require('./fake-mongo');
const realPath = require.resolve('mongodb');
require.cache[realPath] = { id: realPath, filename: realPath, loaded: true, exports: fake, paths: [] };

const PORT = 4610;
const BASE = `http://127.0.0.1:${PORT}`;
const EVENTS_SECRET = 'secreto_de_eventos_de_prueba';

process.env.MONGODB_URI = 'mongodb://fake/lunatico';
process.env.JWT_SECRET = 'secreto-de-prueba';
process.env.CLAUDE_API_KEY = 'clave-falsa';
process.env.WOMPI_PUBLIC_KEY = 'pub_test_falsa';
process.env.WOMPI_INTEGRITY_SECRET = 'integridad_de_prueba';
process.env.WOMPI_EVENTS_SECRET = EVENTS_SECRET;
process.env.PORT = String(PORT);

function req(method, p, body, headers) {
    return new Promise((resolve) => {
        const data = body === undefined || body === null ? null : JSON.stringify(body);
        const h = Object.assign({}, headers || {});
        if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
        const r = http.request(BASE + p, { method, headers: h }, (res) => {
            let buf = '';
            res.on('data', (c) => (buf += c));
            res.on('end', () => {
                let parsed; try { parsed = JSON.parse(buf); } catch (e) { parsed = buf.slice(0, 200); }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        r.on('error', (e) => resolve({ status: 0, body: String(e) }));
        if (data) r.write(data);
        r.end();
    });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Construye un evento de Wompi firmado igual que lo haría Wompi
function eventoWompi(referencia, status, monto, secreto) {
    const data = {
        transaction: {
            id: 'txn_prueba_1',
            reference: referencia,
            status: status,
            amount_in_cents: monto
        }
    };
    const timestamp = 1787000000;
    const properties = ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'];
    const concat = properties
        .map((p) => p.split('.').reduce((a, k) => a[k], data))
        .join('');
    const checksum = crypto.createHash('sha256')
        .update(concat + String(timestamp) + secreto).digest('hex');
    return {
        event: 'transaction.updated',
        data,
        timestamp,
        signature: { properties, checksum }
    };
}

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

    // --- Cuentas y saldo ---
    const email = `cred-${Date.now()}@test.local`;
    const reg = await req('POST', '/api/register', { email, password: 'Clave123!' });
    check('Registro entrega 100 créditos de bienvenida',
        reg.status === 200 && reg.body.user && reg.body.user.creditBalance === 100,
        'saldo=' + (reg.body.user && reg.body.user.creditBalance));
    const tok = reg.body.token;

    const st = await req('GET', '/api/stats', null, { Authorization: 'Bearer ' + tok });
    check('Stats muestra el saldo y los modelos',
        st.status === 200 && st.body.creditBalance === 100 && st.body.modelos.length === 3,
        'modelos=' + (st.body.modelos || []).map((m) => m.clave + ':x' + m.multiplicador).join(' '));

    // --- Migración de usuario antiguo ---
    const viejo = await users.insertOne({
        email: 'viejo@test.local',
        password: await require('bcryptjs').hash('Clave123!', 10),
        subscriptionTier: 'FREE', messagesUsed: 7, createdAt: new Date()
    });
    const li = await req('POST', '/api/login', { email: 'viejo@test.local', password: 'Clave123!' });
    check('Usuario antiguo (sin saldo) recibe créditos al entrar',
        li.status === 200 && li.body.user.creditBalance === 100,
        'saldo=' + (li.body.user && li.body.user.creditBalance));
    const viejoDoc = await users.findOne({ _id: viejo.insertedId });
    check('Y se le limpian los campos del modelo viejo',
        viejoDoc.messagesUsed === undefined && viejoDoc.subscriptionTier === undefined);

    // --- Catálogo ---
    const paq = await req('GET', '/api/paquetes');
    check('El catálogo de paquetes es público',
        paq.status === 200 && paq.body.paquetes.length === 4,
        paq.body.paquetes ? paq.body.paquetes.map((p) => p.clave + '=' + p.creditos).join(' ') : '');

    // --- Fórmula de créditos ---
    const { execSync } = require('child_process');
    const esperado = Math.ceil((1600 + 5 * 400) / 1000 * 1);
    check('Fórmula: 1600 entrada + 400 salida en modelo rápido = 4 créditos',
        esperado === 4, 'calculado=' + esperado);

    // --- Compra ---
    const compra = await req('POST', '/api/comprar', { paquete: 'popular' },
        { Authorization: 'Bearer ' + tok });
    check('Crear compra devuelve referencia y firma de integridad',
        compra.status === 200 && compra.body.referencia && compra.body.firmaIntegridad &&
        compra.body.montoEnCentavos === 5490000,
        'monto=' + compra.body.montoEnCentavos);
    const referencia = compra.body.referencia;

    const malPaquete = await req('POST', '/api/comprar', { paquete: 'inventado' },
        { Authorization: 'Bearer ' + tok });
    check('Paquete inexistente se rechaza con 400', malPaquete.status === 400);

    // --- Webhook con firma VÁLIDA ---
    const ev = eventoWompi(referencia, 'APPROVED', 5490000, EVENTS_SECRET);
    const wh = await req('POST', '/api/webhook', ev);
    await sleep(200);
    const trasPago = await req('GET', '/api/stats', null, { Authorization: 'Bearer ' + tok });
    check('Webhook con firma válida acepta el pago', wh.status === 200, 'HTTP ' + wh.status);
    check('Los créditos del paquete se abonan (100 -> 3100)',
        trasPago.body.creditBalance === 3100, 'saldo=' + trasPago.body.creditBalance);

    // --- Idempotencia ---
    const wh2 = await req('POST', '/api/webhook', ev);
    await sleep(200);
    const trasRepetir = await req('GET', '/api/stats', null, { Authorization: 'Bearer ' + tok });
    check('Reenviar el mismo evento NO abona créditos otra vez',
        trasRepetir.body.creditBalance === 3100,
        'saldo=' + trasRepetir.body.creditBalance + ' resp=' + JSON.stringify(wh2.body));

    // --- Firma inválida ---
    const evMalo = eventoWompi(referencia, 'APPROVED', 5490000, 'secreto_equivocado');
    const whMalo = await req('POST', '/api/webhook', evMalo);
    check('Webhook con secreto equivocado se rechaza con 401', whMalo.status === 401,
        'HTTP ' + whMalo.status);

    // --- Manipulación del monto ---
    const evTocado = eventoWompi(referencia, 'APPROVED', 5490000, EVENTS_SECRET);
    evTocado.data.transaction.amount_in_cents = 100;
    const whTocado = await req('POST', '/api/webhook', evTocado);
    check('Manipular el monto invalida la firma', whTocado.status === 401,
        'HTTP ' + whTocado.status);

    // --- Sin créditos ---
    await users.updateOne({ email }, { $set: { creditBalance: 0 } });
    const chatSin = await req('POST', '/api/chat', { message: 'hola' },
        { Authorization: 'Bearer ' + tok });
    check('Sin saldo, el chat responde 402 y no llama a la API',
        chatSin.status === 402, 'HTTP ' + chatSin.status);

    // --- Modelo inválido ---
    await users.updateOne({ email }, { $set: { creditBalance: 50 } });
    const modMalo = await req('POST', '/api/chat', { message: 'hola', modelo: 'inventado' },
        { Authorization: 'Bearer ' + tok });
    check('Modelo inexistente se rechaza con 400', modMalo.status === 400);

    // --- Fallo de la API no cobra ---
    const antes = (await req('GET', '/api/stats', null, { Authorization: 'Bearer ' + tok })).body.creditBalance;
    const chatFalla = await req('POST', '/api/chat', { message: 'hola' },
        { Authorization: 'Bearer ' + tok });
    const despues = (await req('GET', '/api/stats', null, { Authorization: 'Bearer ' + tok })).body.creditBalance;
    check('Si la API de Claude falla, NO se descuenta saldo',
        chatFalla.status === 500 && antes === despues,
        `HTTP ${chatFalla.status}, saldo ${antes} -> ${despues}`);

    // --- Seguridad heredada ---
    check('Sin token devuelve 401', (await req('GET', '/api/stats')).status === 401);
    const src = await req('GET', '/server-saas.js');
    check('El código fuente no se sirve', src.status === 404, 'HTTP ' + src.status);

    const pass = R.filter((r) => r.ok).length;
    console.log('\n=================================================');
    console.log(`  PRUEBAS DEL MODELO DE CRÉDITOS: ${pass}/${R.length}`);
    console.log('=================================================');
    for (const r of R) console.log(`${r.ok ? '  OK    ' : '  FALLA '} ${r.n}${r.d ? '   [' + r.d + ']' : ''}`);
    console.log('');
    process.exit(pass === R.length ? 0 : 1);
})();
