// server-saas.js - LunaticoIA SaaS Backend
// Modelo de créditos prepago + MongoDB + Wompi
require('dotenv').config();

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcryptjs = require('bcryptjs');
const Anthropic = require('@anthropic-ai/sdk');
const { MongoClient, ObjectId } = require('mongodb');
const https = require('https');

// Fail fast si falta configuración crítica
const REQUIRED_ENV = ['MONGODB_URI', 'JWT_SECRET', 'CLAUDE_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
    console.error('✗ Faltan variables de entorno obligatorias: ' + missingEnv.join(', '));
    process.exit(1);
}

const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
// 15mb porque /api/chat acepta una imagen adjunta en base64 (hasta 10mb
// codificada, el limite de la API de Claude); el resto de las rutas mandan
// cuerpos chiquitos, asi que este limite mas alto no les cambia nada.
app.use(express.json({ limit: '15mb' }));

let db;
const client = new MongoClient(process.env.MONGODB_URI);
const claudeClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ---------------------------------------------------------------------------
// Modelo de créditos
//
// En los tres modelos la salida cuesta exactamente 5x la entrada, así que una
// sola fórmula sirve para todos:
//
//     facturables = entrada + 5 x salida
//     1 crédito   = 1.000 facturables
//     cobro       = (facturables / 1000) x multiplicador_del_modelo
//
// Los multiplicadores siguen la proporción de precios de entrada (1:3:5), así
// que el margen es idéntico use el usuario el modelo que use.
// ---------------------------------------------------------------------------

const TOKENS_POR_CREDITO = 1000;
const PESO_SALIDA = 5;

// Herramientas que la IA puede usar en cada respuesta: buscar en internet y
// abrir/leer paginas web, y correr codigo (Python/Bash) en un sandbox propio
// de Anthropic. Ambas las ejecuta la API del lado de Anthropic; nunca abren
// ni corren nada en este servidor.
const HERRAMIENTAS_IA = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 5 },
    { type: 'code_execution_20250825', name: 'code_execution' }
];

// Solo la busqueda tiene costo aparte de los tokens ($10 cada 1.000 = $0,01,
// -> 10 creditos al tipo de cambio de Rapido). Leer una pagina (web_fetch) y
// correr codigo salen gratis -- code_execution tiene su propio cupo mensual
// de horas de Anthropic, muy por encima de lo que un chat como este va a
// usar, y web_fetch no cobra nada aparte de los tokens que consume.
const CREDITOS_POR_BUSQUEDA = 10;

// Imagenes adjuntas al chat (para que el usuario muestre capturas, disenos o
// mockups de su proyecto). Van directo en el mensaje como bloque "image", sin
// pasar por la Files API: mas simple, y no hay que limpiar archivos despues.
// Limites de la API de Claude: 10MB en base64, JPEG/PNG/GIF/WEBP.
const TIPOS_IMAGEN_PERMITIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_BASE64_IMAGEN = 14 * 1024 * 1024; // ~10MB reales, con margen del inflado de base64

// Multiplicadores = precio de entrada de cada modelo dividido entre el de
// Rápido (Haiku, $1/MTok): Sonnet $2, Opus $5, Fable $10 -> 1 : 2(*) : 5 : 10.
// (*) Equilibrado quedó en 3x desde antes de que Sonnet bajara de precio; no
// se toca aca porque cambiar eso afecta el margen de cuentas ya existentes.
const MODELOS = {
    rapido:   { id: 'claude-haiku-4-5-20251001',  multiplicador: 1, etiqueta: 'Rápido'   },
    equilibrado: { id: 'claude-sonnet-5', multiplicador: 3, etiqueta: 'Equilibrado' },
    avanzado: { id: 'claude-opus-5',      multiplicador: 5, etiqueta: 'Avanzado' },
    maximo:   { id: 'claude-fable-5',     multiplicador: 10, etiqueta: 'Máximo' }
};
const MODELO_POR_DEFECTO = 'rapido';

const CREDITOS_DE_BIENVENIDA = 100;
// Con herramientas de por medio (sobre todo code_execution generando codigo
// largo, como una pagina web completa) una respuesta puede necesitar mucho
// mas espacio de salida del que parece. En 4096 se estaba cortando a mitad
// de camino sin avisar -- el usuario veia "aqui voy..." y despues nada, sin
// forma de saber si seguia trabajando o se habia quedado pegado.
const MAX_TOKENS_RESPUESTA = 16384;
const MENSAJES_DE_HISTORIAL = 10;

const PAQUETES = {
    prueba:  { creditos: 400,   precioCOP: 9900,   nombre: 'Prueba'  },
    basico:  { creditos: 1200,  precioCOP: 24900,  nombre: 'Básico'  },
    popular: { creditos: 3000,  precioCOP: 54900,  nombre: 'Popular' },
    pro:     { creditos: 8000,  precioCOP: 129900, nombre: 'Pro'     }
};

// El detalle del fallo va al log; al cliente solo un mensaje util. Antes se
// devolvia error.message tal cual, y el usuario llegaba a ver el JSON de la
// API de Anthropic con su request_id dentro del chat.
function fallo(res, codigo, publico, error, contexto) {
    console.error('✗ ' + contexto + ':', (error && error.message) || error);
    res.status(codigo).json({ error: publico });
}

function creditosDe(usage, multiplicador) {
    const entrada = (usage && usage.input_tokens) || 0;
    const salida  = (usage && usage.output_tokens) || 0;
    const facturables = entrada + PESO_SALIDA * salida;
    const busquedas = (usage && usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
    return Math.ceil((facturables / TOKENS_POR_CREDITO) * multiplicador) + busquedas * CREDITOS_POR_BUSQUEDA;
}

// Los usuarios creados antes del modelo de créditos no tienen saldo. En vez de
// dejarlos rotos, se les asigna el saldo de bienvenida la primera vez.
async function asegurarSaldo(users, user) {
    if (typeof user.creditBalance === 'number') return user;
    await users.updateOne(
        { _id: user._id },
        {
            $set: { creditBalance: CREDITOS_DE_BIENVENIDA },
            $unset: { subscriptionTier: '', messagesUsed: '', quotaResetAt: '' }
        }
    );
    user.creditBalance = CREDITOS_DE_BIENVENIDA;
    return user;
}

// Los usuarios creados antes de la verificación de correo no tienen el campo
// emailVerified. Se dan por verificados para no bloquear a nadie con cuenta
// vieja de un día para otro.
async function asegurarVerificado(users, user) {
    if (typeof user.emailVerified === 'boolean') return user;
    await users.updateOne({ _id: user._id }, { $set: { emailVerified: true } });
    user.emailVerified = true;
    return user;
}

function generarToken() {
    return crypto.randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Wompi
//
// Ojo: a diferencia de Stripe, Wompi NO firma el cuerpo crudo. La firma es un
// SHA256 de los valores de ciertas propiedades + timestamp + secreto, así que
// express.json() por delante no rompe nada aquí.
// ---------------------------------------------------------------------------

const WOMPI_CONFIGURADO = Boolean(
    process.env.WOMPI_PUBLIC_KEY &&
    process.env.WOMPI_INTEGRITY_SECRET &&
    process.env.WOMPI_EVENTS_SECRET
);

function valorPorRuta(obj, ruta) {
    return ruta.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function firmaEventoValida(body) {
    const sig = body && body.signature;
    if (!sig || !Array.isArray(sig.properties) || !sig.checksum) return false;

    const concatenado = sig.properties
        .map((p) => {
            const v = valorPorRuta(body.data, p);
            return v === undefined || v === null ? '' : String(v);
        })
        .join('');

    const cadena = concatenado + String(body.timestamp) + process.env.WOMPI_EVENTS_SECRET;
    const calculado = crypto.createHash('sha256').update(cadena).digest('hex');

    const a = Buffer.from(calculado, 'utf8');
    const b = Buffer.from(String(sig.checksum).toLowerCase(), 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Firma de integridad que exige el checkout de Wompi
function firmaIntegridad(referencia, montoEnCentavos, moneda) {
    return crypto
        .createHash('sha256')
        .update(`${referencia}${montoEnCentavos}${moneda}${process.env.WOMPI_INTEGRITY_SECRET}`)
        .digest('hex');
}

// ---------------------------------------------------------------------------
// Correo (verificación de cuenta y recuperación de contraseña)
//
// Mismo patrón que Wompi: si no hay Resend configurado, la funcionalidad se
// apaga sola en vez de romper el resto de la app. Sin correo configurado,
// las cuentas nuevas quedan verificadas de entrada (como siempre) y
// /api/olvide-password responde 503, igual que /api/comprar sin Wompi.
//
// Se usa la API HTTP de Resend (puerto 443) en vez de su relay SMTP: Railway
// bloquea el tráfico saliente por los puertos 25/465/587, así que el envío
// por SMTP nunca llegaba a conectar (timeout) aunque las credenciales fueran
// correctas.
// ---------------------------------------------------------------------------

const CORREO_CONFIGURADO = Boolean(process.env.RESEND_API_KEY);
const CORREO_REMITENTE = process.env.SMTP_FROM;
const VENCIMIENTO_VERIFICACION_MS = 24 * 60 * 60 * 1000;
const VENCIMIENTO_RESET_MS = 60 * 60 * 1000;

function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// Node 14 (la versión que corre en Railway) no trae fetch global, así que se
// llama a la API de Resend con el módulo https del propio Node.
function llamarResendAPI(payload) {
    return new Promise((resolve, reject) => {
        const datos = JSON.stringify(payload);
        const peticion = https.request(
            {
                hostname: 'api.resend.com',
                path: '/emails',
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(datos)
                }
            },
            (res) => {
                let cuerpo = '';
                res.on('data', (trozo) => { cuerpo += trozo; });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve();
                    } else {
                        reject(new Error(`Resend respondió ${res.statusCode}: ${cuerpo}`));
                    }
                });
            }
        );
        peticion.on('error', reject);
        peticion.write(datos);
        peticion.end();
    });
}

// Nunca deja que un correo que falla tumbe la petición que lo disparó
// (registro, compra de créditos, etc.): se registra en el log y ya.
async function enviarCorreo(destinatario, asunto, textoPlano, html) {
    if (!CORREO_CONFIGURADO) {
        console.warn(`⚠ Correo no configurado, no se envió "${asunto}" a ${destinatario}`);
        return false;
    }
    try {
        await llamarResendAPI({ from: CORREO_REMITENTE, to: destinatario, subject: asunto, text: textoPlano, html });
        return true;
    } catch (error) {
        console.error('✗ Error enviando correo:', error.message);
        return false;
    }
}

function enviarVerificacion(req, destinatario, nombre, token) {
    const link = `${req.protocol}://${req.get('host')}/api/verificar-correo?token=${token}`;
    return enviarCorreo(
        destinatario,
        'Confirma tu correo en LunaticoIA',
        `Hola${nombre ? ' ' + nombre : ''},\n\nConfirma tu correo para empezar a chatear en LunaticoIA:\n${link}\n\n` +
            'El enlace vence en 24 horas. Si no creaste esta cuenta, ignora este mensaje.',
        `<p>Hola${nombre ? ' ' + escHtml(nombre) : ''},</p>` +
            '<p>Confirma tu correo para empezar a chatear en LunaticoIA:</p>' +
            `<p><a href="${link}">Confirmar mi correo</a></p>` +
            '<p>El enlace vence en 24 horas. Si no creaste esta cuenta, ignora este mensaje.</p>'
    );
}

function enviarRecuperacion(req, destinatario, token) {
    const link = `${req.protocol}://${req.get('host')}/?reset=${token}`;
    return enviarCorreo(
        destinatario,
        'Recupera tu contraseña en LunaticoIA',
        `Para elegir una nueva contraseña entra aquí (vence en 1 hora):\n${link}\n\n` +
            'Si no lo pediste tú, ignora este mensaje: tu contraseña sigue igual.',
        '<p>Para elegir una nueva contraseña entra aquí (vence en 1 hora):</p>' +
            `<p><a href="${link}">Elegir nueva contraseña</a></p>` +
            '<p>Si no lo pediste tú, ignora este mensaje: tu contraseña sigue igual.</p>'
    );
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });

    jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

const registerLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados registros desde esta IP. Inténtalo más tarde.' }
});

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados intentos de acceso. Espera unos minutos.' }
});

const chatLimiter = rateLimit({
    windowMs: 60 * 1000, max: 20,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiadas peticiones. Espera un momento.' }
});

const verificacionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 3,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Ya reenviamos el correo hace poco. Espera unos minutos.' }
});

const recuperarLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, max: 5,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiadas solicitudes. Espera unos minutos.' }
});

// ---------------------------------------------------------------------------
// Estáticos (sin exponer el código fuente)
// ---------------------------------------------------------------------------

app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    next();
});

const BLOQUEADOS = /\.(js|json|md|bat|ps1|lock|yml|yaml)$/i;
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (BLOQUEADOS.test(req.path)) return res.status(404).end();
    next();
});
app.use(express.static('.', { dotfiles: 'ignore', index: 'index.html' }));

// ---------------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------------

async function connectDatabase() {
    try {
        await client.connect();
        db = client.db('lunatico_ia');

        const users = db.collection('users');
        const messages = db.collection('messages');
        const compras = db.collection('compras');

        await users.createIndex({ email: 1 }, { unique: true });
        await users.createIndex({ verificationToken: 1 }, { sparse: true });
        await users.createIndex({ resetToken: 1 }, { sparse: true });
        await messages.createIndex({ userId: 1, createdAt: -1 });
        await compras.createIndex({ referencia: 1 }, { unique: true });

        console.log('✓ MongoDB connected successfully');
    } catch (error) {
        console.error('✗ MongoDB connection failed:', error.message);
        process.exit(1);
    }
}

// ---------------------------------------------------------------------------
// Cuentas
// ---------------------------------------------------------------------------

app.post('/api/register', registerLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const users = db.collection('users');
        const existing = await users.findOne({ email: email.toLowerCase() });
        if (existing) return res.status(400).json({ error: 'User already exists' });

        const hashed = await bcryptjs.hash(password, 10);
        // Sin correo configurado, nadie queda bloqueado: se da la cuenta por
        // verificada de una vez, igual que se hacía antes de esta función.
        const verificationToken = CORREO_CONFIGURADO ? generarToken() : null;
        const user = {
            email: email.toLowerCase(),
            name: name || email.split('@')[0],
            password: hashed,
            creditBalance: CREDITOS_DE_BIENVENIDA,
            createdAt: new Date(),
            emailVerified: !CORREO_CONFIGURADO,
            verificationToken,
            verificationTokenExpira: CORREO_CONFIGURADO ? new Date(Date.now() + VENCIMIENTO_VERIFICACION_MS) : null
        };

        const result = await users.insertOne(user);
        const token = jwt.sign(
            { userId: result.insertedId.toString(), email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        if (CORREO_CONFIGURADO) {
            enviarVerificacion(req, user.email, user.name, verificationToken);
        }

        res.json({
            message: 'User registered successfully',
            token,
            user: {
                email: user.email,
                name: user.name,
                creditBalance: user.creditBalance,
                emailVerified: user.emailVerified
            }
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos crear la cuenta. Inténtalo de nuevo en un momento.', error, 'registro');
    }
});

app.post('/api/login', loginLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }

        const users = db.collection('users');
        let user = await users.findOne({ email: email.toLowerCase() });
        if (!user) return res.status(401).json({ error: 'Invalid credentials' });

        const ok = await bcryptjs.compare(password, user.password);
        if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

        user = await asegurarSaldo(users, user);
        user = await asegurarVerificado(users, user);

        const token = jwt.sign(
            { userId: user._id.toString(), email: user.email },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );

        res.json({
            message: 'Login successful',
            token,
            user: {
                email: user.email,
                name: user.name || '',
                creditBalance: user.creditBalance,
                emailVerified: user.emailVerified
            }
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos iniciar sesión. Inténtalo de nuevo en un momento.', error, 'login');
    }
});

app.get('/api/stats', authenticateToken, async (req, res) => {
    try {
        const users = db.collection('users');
        let user = await users.findOne({ _id: new ObjectId(req.user.userId) });
        if (!user) return res.status(404).json({ error: 'User not found' });

        user = await asegurarSaldo(users, user);
        user = await asegurarVerificado(users, user);

        res.json({
            email: user.email,
            name: user.name || user.email.split('@')[0],
            creditBalance: user.creditBalance,
            creditosIlimitados: user.creditosIlimitados === true,
            creditosPorBusqueda: CREDITOS_POR_BUSQUEDA,
            emailVerified: user.emailVerified,
            correoConfigurado: CORREO_CONFIGURADO,
            modelos: Object.keys(MODELOS).map((k) => ({
                clave: k,
                etiqueta: MODELOS[k].etiqueta,
                multiplicador: MODELOS[k].multiplicador
            }))
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos cargar los datos de tu cuenta.', error, 'stats');
    }
});

// ---------------------------------------------------------------------------
// Verificación de correo
// ---------------------------------------------------------------------------

// GET porque es un enlace que se abre desde el cliente de correo, no una
// llamada de la app. Redirige a la landing con el resultado en la URL.
app.get('/api/verificar-correo', async (req, res) => {
    try {
        const token = req.query.token;
        if (!token || !db) return res.redirect('/?verificacion=invalida');

        const users = db.collection('users');
        const user = await users.findOne({ verificationToken: token });

        if (!user || !user.verificationTokenExpira || user.verificationTokenExpira < new Date()) {
            return res.redirect('/?verificacion=invalida');
        }

        await users.updateOne(
            { _id: user._id },
            { $set: { emailVerified: true }, $unset: { verificationToken: '', verificationTokenExpira: '' } }
        );

        res.redirect('/?verificacion=ok');
    } catch (error) {
        console.error('✗ verificar-correo:', error.message);
        res.redirect('/?verificacion=error');
    }
});

app.post('/api/reenviar-verificacion', verificacionLimiter, authenticateToken, async (req, res) => {
    try {
        if (!CORREO_CONFIGURADO) {
            return res.status(503).json({ error: 'Verificación de correo no configurada todavía' });
        }

        const users = db.collection('users');
        let user = await users.findOne({ _id: new ObjectId(req.user.userId) });
        if (!user) return res.status(404).json({ error: 'User not found' });
        user = await asegurarVerificado(users, user);

        if (user.emailVerified) {
            return res.json({ message: 'Tu correo ya está verificado.' });
        }

        const verificationToken = generarToken();
        await users.updateOne(
            { _id: user._id },
            {
                $set: {
                    verificationToken,
                    verificationTokenExpira: new Date(Date.now() + VENCIMIENTO_VERIFICACION_MS)
                }
            }
        );

        await enviarVerificacion(req, user.email, user.name, verificationToken);
        res.json({ message: 'Te reenviamos el correo de verificación.' });
    } catch (error) {
        fallo(res, 500, 'No pudimos reenviar el correo.', error, 'reenviar-verificacion');
    }
});

// ---------------------------------------------------------------------------
// Recuperación de contraseña
// ---------------------------------------------------------------------------

app.post('/api/olvide-password', recuperarLimiter, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ error: 'Correo requerido' });

        if (!CORREO_CONFIGURADO) {
            return res.status(503).json({ error: 'Recuperación de contraseña no configurada todavía. Contáctanos.' });
        }

        const users = db.collection('users');
        const user = await users.findOne({ email: email.toLowerCase() });

        // La respuesta es la misma exista o no la cuenta: no revelamos qué
        // correos están registrados.
        if (user) {
            const resetToken = generarToken();
            await users.updateOne(
                { _id: user._id },
                { $set: { resetToken, resetTokenExpira: new Date(Date.now() + VENCIMIENTO_RESET_MS) } }
            );
            enviarRecuperacion(req, user.email, resetToken);
        }

        res.json({ message: 'Si ese correo tiene una cuenta, te enviamos un enlace para recuperar tu contraseña.' });
    } catch (error) {
        fallo(res, 500, 'No pudimos procesar la solicitud.', error, 'olvide-password');
    }
});

app.post('/api/resetear-password', recuperarLimiter, async (req, res) => {
    try {
        const { token, password } = req.body;
        if (!token || !password) return res.status(400).json({ error: 'Faltan datos' });
        if (String(password).length < 8) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
        }

        const users = db.collection('users');
        const user = await users.findOne({ resetToken: token });
        if (!user || !user.resetTokenExpira || user.resetTokenExpira < new Date()) {
            return res.status(400).json({ error: 'El enlace no es válido o ya venció. Pide uno nuevo.' });
        }

        const hashed = await bcryptjs.hash(password, 10);
        await users.updateOne(
            { _id: user._id },
            { $set: { password: hashed }, $unset: { resetToken: '', resetTokenExpira: '' } }
        );

        res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
    } catch (error) {
        fallo(res, 500, 'No pudimos actualizar la contraseña.', error, 'resetear-password');
    }
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

app.post('/api/chat', chatLimiter, authenticateToken, async (req, res) => {
    try {
        const { message, imagen } = req.body;
        const claveModelo = req.body.modelo || MODELO_POR_DEFECTO;
        const mensajeTexto = typeof message === 'string' ? message.trim() : '';

        let imagenValida = null;
        if (imagen != null) {
            if (
                typeof imagen !== 'object' ||
                !TIPOS_IMAGEN_PERMITIDOS.includes(imagen.mediaType) ||
                typeof imagen.datos !== 'string' ||
                !imagen.datos ||
                imagen.datos.length > MAX_BASE64_IMAGEN
            ) {
                return res.status(400).json({ error: 'Imagen no válida' });
            }
            imagenValida = { mediaType: imagen.mediaType, datos: imagen.datos };
        }

        if (!mensajeTexto && !imagenValida) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }
        if (!MODELOS[claveModelo]) {
            return res.status(400).json({ error: 'Modelo no válido' });
        }
        const modelo = MODELOS[claveModelo];

        const users = db.collection('users');
        const messages = db.collection('messages');
        const userId = new ObjectId(req.user.userId);

        let user = await users.findOne({ _id: userId });
        if (!user) return res.status(404).json({ error: 'User not found' });
        user = await asegurarSaldo(users, user);
        user = await asegurarVerificado(users, user);

        if (!user.emailVerified) {
            return res.status(403).json({
                error: 'Verifica tu correo antes de empezar a chatear. Revisa tu bandeja de entrada o pide que te reenviemos el enlace.',
                correoSinVerificar: true
            });
        }

        const ilimitado = user.creditosIlimitados === true;

        if (!ilimitado && user.creditBalance <= 0) {
            return res.status(402).json({
                error: 'Sin créditos',
                creditBalance: 0,
                mensaje: 'Se te acabaron los créditos. Compra un paquete para seguir.'
            });
        }

        const history = await messages
            .find({ userId })
            .sort({ createdAt: -1, _id: -1 })
            .limit(MENSAJES_DE_HISTORIAL)
            .toArray();

        let messagesForClaude = history
            .reverse()
            .map((m) => ({ role: m.role, content: m.content }));

        // La API exige que el historial empiece por un turno de usuario.
        while (messagesForClaude.length && messagesForClaude[0].role !== 'user') {
            messagesForClaude.shift();
        }

        // La imagen va antes del texto (asi rinde mejor, segun la propia
        // guia de Anthropic) y como bloques, no como string; sin imagen se
        // manda el texto solo, igual que antes.
        messagesForClaude.push({
            role: 'user',
            content: imagenValida
                ? [
                      { type: 'image', source: { type: 'base64', media_type: imagenValida.mediaType, data: imagenValida.datos } },
                      { type: 'text', text: mensajeTexto || 'Mira esta imagen.' }
                  ]
                : mensajeTexto
        });

        const response = await claudeClient.messages.create({
            model: modelo.id,
            max_tokens: MAX_TOKENS_RESPUESTA,
            messages: messagesForClaude,
            tools: HERRAMIENTAS_IA
        });

        // Con herramientas de por medio la respuesta trae varios bloques de
        // texto intercalados con los de busqueda/lectura/codigo (p.ej. "voy a
        // buscar..." + resultados + la respuesta final): hay que juntarlos
        // todos, no solo quedarse con el primero.
        let aiMessage = '';
        if (response.content && Array.isArray(response.content)) {
            aiMessage = response.content
                .filter((i) => i.type === 'text')
                .map((i) => i.text)
                .join('');
        }
        if (!aiMessage) throw new Error('Invalid response from Claude API');

        // Si la respuesta se corto (llego al limite de tokens, o Anthropic la
        // pauso a mitad de una busqueda/ejecucion de codigo larga) el usuario
        // se quedaba viendo un mensaje a medias sin ninguna pista de que
        // paso -- como si la IA se hubiera quedado pegada. Se avisa explicito.
        const cortada = response.stop_reason === 'max_tokens' || response.stop_reason === 'pause_turn';
        if (cortada) {
            aiMessage += (aiMessage ? '\n\n' : '') + '⚠️ *La respuesta se cortó antes de terminar' +
                (response.stop_reason === 'max_tokens'
                    ? ' (llegó al límite de longitud)'
                    : ' (una búsqueda o ejecución de código larga quedó a medias)') +
                '. Escribe "continúa" para que siga.*';
        }

        // Se cobra DESPUÉS de una respuesta correcta: si la API falla, el
        // usuario no pierde saldo. Las cuentas con creditosIlimitados nunca
        // bajan de saldo (pensadas para el propio creador de LunaticoIA).
        const cobro = creditosDe(response.usage, modelo.multiplicador);
        const nuevoSaldo = ilimitado ? user.creditBalance : Math.max(0, user.creditBalance - cobro);

        // El historial guarda solo texto, nunca la imagen: no tiene sentido
        // acumular fotos en la base para siempre, y evita que cada turno
        // futuro tenga que volver a mandarle a Claude las imagenes viejas.
        // Consecuencia: en un turno posterior Claude ya no "ve" la imagen,
        // solo lo que se haya dicho sobre ella.
        const guardadoEn = new Date();
        await messages.insertOne({
            userId, role: 'user',
            content: (imagenValida ? '[imagen adjunta] ' : '') + mensajeTexto,
            createdAt: guardadoEn
        });
        await messages.insertOne({
            userId, role: 'assistant', content: aiMessage,
            createdAt: new Date(guardadoEn.getTime() + 1)
        });

        if (!ilimitado) {
            await users.updateOne({ _id: userId }, { $set: { creditBalance: nuevoSaldo } });
        }

        const uso = response.usage || {};
        res.json({
            response: aiMessage,
            consumo: {
                modelo: modelo.etiqueta,
                tokensEntrada: uso.input_tokens != null ? uso.input_tokens : null,
                tokensSalida: uso.output_tokens != null ? uso.output_tokens : null,
                busquedas: (uso.server_tool_use && uso.server_tool_use.web_search_requests) || 0,
                lecturasWeb: (uso.server_tool_use && uso.server_tool_use.web_fetch_requests) || 0,
                creditosCobrados: cobro,
                creditBalance: nuevoSaldo,
                creditosIlimitados: ilimitado,
                cortada: cortada
            }
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos generar la respuesta. No se te descontó ningún crédito.', error, 'chat');
    }
});

// ---------------------------------------------------------------------------
// Compra de paquetes (Wompi)
// ---------------------------------------------------------------------------

app.get('/api/paquetes', (req, res) => {
    res.json({
        moneda: 'COP',
        paquetes: Object.keys(PAQUETES).map((k) => ({
            clave: k,
            nombre: PAQUETES[k].nombre,
            creditos: PAQUETES[k].creditos,
            precioCOP: PAQUETES[k].precioCOP
        }))
    });
});

app.post('/api/comprar', authenticateToken, async (req, res) => {
    try {
        if (!WOMPI_CONFIGURADO) {
            return res.status(503).json({ error: 'Pagos no configurados todavía' });
        }

        const { paquete } = req.body;
        if (!paquete || !PAQUETES[paquete]) {
            return res.status(400).json({ error: 'Paquete no válido' });
        }
        const p = PAQUETES[paquete];

        const users = db.collection('users');
        const compras = db.collection('compras');
        const userId = new ObjectId(req.user.userId);
        const user = await users.findOne({ _id: userId });
        if (!user) return res.status(404).json({ error: 'User not found' });

        const referencia = `LUNA-${userId.toString()}-${Date.now()}`;
        const montoEnCentavos = p.precioCOP * 100;

        await compras.insertOne({
            referencia,
            userId,
            paquete,
            creditos: p.creditos,
            montoEnCentavos,
            estado: 'PENDIENTE',
            createdAt: new Date()
        });

        res.json({
            referencia,
            publicKey: process.env.WOMPI_PUBLIC_KEY,
            montoEnCentavos,
            moneda: 'COP',
            firmaIntegridad: firmaIntegridad(referencia, montoEnCentavos, 'COP'),
            creditos: p.creditos,
            nombre: p.nombre
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos iniciar el pago. Inténtalo de nuevo.', error, 'compra');
    }
});

app.post('/api/webhook', async (req, res) => {
    try {
        if (!WOMPI_CONFIGURADO) return res.status(503).json({ error: 'No configurado' });

        if (!firmaEventoValida(req.body)) {
            console.error('✗ Webhook con firma inválida');
            return res.status(401).json({ error: 'Firma inválida' });
        }

        if (!db) return res.status(503).json({ error: 'Service not ready' });

        const evento = req.body.event;
        const tx = req.body.data && req.body.data.transaction;

        if (evento === 'transaction.updated' && tx && tx.status === 'APPROVED') {
            const compras = db.collection('compras');
            const users = db.collection('users');

            const compra = await compras.findOne({ referencia: tx.reference });
            if (!compra) {
                console.warn('⚠ Pago aprobado sin compra registrada:', tx.reference);
                return res.json({ received: true });
            }

            // Idempotencia: Wompi reintenta, y no queremos regalar créditos dos veces.
            if (compra.estado === 'APROBADA') {
                return res.json({ received: true, duplicado: true });
            }

            const marcada = await compras.updateOne(
                { referencia: tx.reference, estado: { $ne: 'APROBADA' } },
                { $set: { estado: 'APROBADA', transactionId: tx.id, aprobadaEn: new Date() } }
            );
            if (marcada.modifiedCount !== 1) {
                return res.json({ received: true, duplicado: true });
            }

            await users.updateOne(
                { _id: compra.userId },
                { $inc: { creditBalance: compra.creditos } }
            );
            console.log(`✓ ${compra.creditos} créditos abonados a ${compra.userId} (${tx.reference})`);
        }

        res.json({ received: true });
    } catch (error) {
        console.error('✗ Webhook error:', error.message);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', message: 'LunaticoIA SaaS Backend is running' });
});

const PORT = process.env.PORT || 3001;
connectDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`✓ LunaticoIA SaaS Server running on port ${PORT}`);
        console.log(`✓ MongoDB: Connected`);
        console.log(`✓ Claude API: Ready`);
        console.log(`✓ Modelo por defecto: ${MODELOS[MODELO_POR_DEFECTO].id}`);
        console.log(`✓ Wompi: ${WOMPI_CONFIGURADO ? 'Configurado' : 'SIN CONFIGURAR (compras deshabilitadas)'}`);
        console.log(`✓ Correo: ${CORREO_CONFIGURADO ? 'Configurado' : 'SIN CONFIGURAR (verificación y recuperación de contraseña deshabilitadas)'}`);
    });
});
