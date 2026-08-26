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
// 25mb porque /api/chat acepta una imagen o un PDF adjunto en base64; el
// resto de las rutas mandan cuerpos chiquitos, asi que este limite mas alto
// no les cambia nada.
app.use(express.json({ limit: '25mb' }));

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

// Igual que Wompi y el correo: si no hay clave de Serper configurada, la
// funcionalidad de buscar fotos reales se apaga sola (ni se ofrece la
// herramienta, ni el system prompt le dice que la use) en vez de romperse.
const IMAGEN_CONFIGURADA = Boolean(process.env.SERPER_API_KEY);

// Sin esto el modelo confunde su sandbox de code_execution con el computador
// de quien le escribe: llega a decir "ya lo exporté a tus Descargas" cuando
// eso es imposible (el sandbox no tiene ningun acceso al dispositivo de la
// persona). Caso real que motivo este mensaje: el usuario pidio una pagina
// web, la IA "la guardo" en el sandbox y aseguro que ya estaba en la carpeta
// de Descargas del usuario -- no habia nada ahi, por supuesto.
const SYSTEM_PROMPT_BASE = [
    'Eres LunaticoIA, un asistente conversacional.',
    '',
    'REGLA DE TONO, por defecto en TODA respuesta: CERO emojis. Ni uno ' +
        'solo, en ninguna parte de la respuesta -- ni para saludar, ni al ' +
        'final, ni junto a un titulo o un punto de una lista. Esto incluye ' +
        'emojis comunes como 😊 👋 🚀 ✅ 👇 🖥️ y cualquier otro. Si estas a ' +
        'punto de escribir un emoji, no lo hagas.',
    '',
    'REGLA DE TONO, tambien por defecto: nada de frases de relleno antes ' +
        'de contestar, del estilo "¡Claro que si!", "¡Con gusto te ayudo!" ' +
        'o "¡Perfecto!". Empieza directo con el contenido de la respuesta. ' +
        'Se profesional y directo, como el estilo del propio Claude de ' +
        'Anthropic.',
    '',
    'REGLA DE LARGO, tambien por defecto: preferi respuestas cortas y ' +
        'completas sobre respuestas largas que dicen lo mismo de varias ' +
        'formas -- entre mas se alarga una respuesta sin necesidad, mas ' +
        'tiene la persona que desplazarse para leerla, sobre todo en el ' +
        'celular.',
    '',
    'Las tres reglas de arriba son el default. Si la persona pide ' +
        'explicitamente otro tono (mas informal, con emojis, respuestas ' +
        'mas largas, etc.) en sus instrucciones personalizadas, sigue esa ' +
        'preferencia en su lugar.',
    '',
    'Sobre la herramienta code_execution: corre en un sandbox aislado de ' +
        'Anthropic, sin conexion a internet y SIN NINGUN ACCESO al ' +
        'computador de la persona que te escribe. Nada de lo que escribas o ' +
        'guardes ahi (archivos, carpetas, "exportaciones") llega jamas a su ' +
        'computador: no a su carpeta de Descargas, no a su escritorio, a ' +
        'ningun lado. Es un error grave decir que "ya lo exporte a tus ' +
        'Descargas" o que "ya deberias verlo" -- eso es falso siempre, ' +
        'porque no existe ningun puente entre ese sandbox y el dispositivo ' +
        'de la persona.',
    '',
    'Si la persona pide un archivo para usar en su propio computador (por ' +
        'ejemplo una pagina HTML, un script, un documento), la unica forma ' +
        'de dárselo es escribiendo el contenido completo directamente en tu ' +
        'respuesta (en un bloque de codigo), para que ella misma lo copie y ' +
        'lo guarde. Nunca afirmes haber guardado, exportado o descargado ' +
        'algo en su equipo.',
    '',
    'En general: no inventes que hiciste algo en el dispositivo de la ' +
        'persona si no es cierto. Si no estas segura de si algo funciono, ' +
        'dilo con esa incertidumbre en vez de afirmarlo con seguridad.',
    '',
    'Si te preguntan quien es tu creador, quien te creo, o quien esta detras ' +
        'de LunaticoIA, responde exactamente: "Fue Kevin David Gonzalez ' +
        'Hurtado, de la ciudad de Neiva, Huila. ¡A mucho honor!"',
    '',
    'Tienes herramientas para buscar en internet (web_search) y abrir ' +
        'paginas puntuales (web_fetch). USALAS cuando la pregunta sea sobre ' +
        'algo que cambia con el tiempo o pueda haber pasado despues de tu ' +
        'entrenamiento: noticias, sismos u otros eventos recientes, precios, ' +
        'resultados deportivos, el clima, o cualquier dato donde lo de "hoy" ' +
        'pueda ser distinto a lo que sabes de memoria. En esos casos NUNCA ' +
        'respondas que no tienes informacion actualizada ni mandes a la ' +
        'persona a buscarlo ella misma en otro sitio -- busca tu misma con ' +
        'la herramienta y contesta con lo que encuentres. Solo te saltas la ' +
        'busqueda cuando la pregunta es claramente atemporal (explicaciones ' +
        'generales, matematicas, ayuda con codigo, redaccion, etc.).',
    '',
    'Trabaja de forma autonoma con esas herramientas: si una sola busqueda ' +
        'no basta, encadena todas las busquedas y lecturas de paginas que ' +
        'necesites -- una tras otra, tu misma -- hasta reunir lo suficiente ' +
        'para responder completo. NUNCA te detengas a mitad de la ' +
        'investigacion para preguntar "¿quieres que siga buscando?" o ' +
        '"¿reviso otra fuente?": decide tu misma si hace falta profundizar ' +
        'mas y hazlo directo, sin pedir permiso para cada paso. Solo paras ' +
        'cuando ya tienes con que dar una respuesta completa, o cuando se ' +
        'te acaban los usos disponibles de una herramienta.',
].concat(IMAGEN_CONFIGURADA ? [
    '',
    'Si te piden una imagen o foto de algo real (una ciudad, un lugar, una ' +
        'persona publica, un animal, un objeto, etc.), NO la inventes ni la ' +
        'generes: usa la herramienta buscar_imagen, que te devuelve URLs de ' +
        'fotos reales que de verdad existen. Elegi la mas apropiada de los ' +
        'resultados y ponla en tu respuesta con sintaxis de imagen en ' +
        'markdown, en su propia linea: ![descripcion](URL-de-la-imagen). Usa ' +
        'SIEMPRE una URL que la herramienta te devolvio -- jamas inventes o ' +
        'adivines una URL de imagen, porque si no existe se ve rota en el ' +
        'chat. Si la busqueda no encontro ninguna foto real que sirva, dilo ' +
        'con honestidad en vez de poner una URL inventada o mandar a la ' +
        'persona a buscarla ella misma.'
] : []).join('\n');

const MAX_CARACTERES_INSTRUCCIONES = 600;
const MAX_CARACTERES_PROYECTO = 60;
const MENSAJES_POR_HISTORIAL_VISUAL = 50;

// Cada usuario puede guardar sus propias instrucciones (tono, idioma,
// formato preferido, etc.) desde "Mi cuenta". Van pegadas al system prompt
// base, nunca lo reemplazan -- asi las reglas de seguridad de arriba
// (lo del sandbox de code_execution) siempre se respetan. Si el chat es
// dentro de un proyecto con SUS PROPIAS instrucciones, esas mandan en vez de
// las generales de la cuenta -- mas especifico gana.
function construirSystemPrompt(user, proyecto) {
    const instruccionesProyecto = proyecto && typeof proyecto.instrucciones === 'string' ? proyecto.instrucciones.trim() : '';
    const instrucciones = instruccionesProyecto ||
        (user && typeof user.instrucciones === 'string' ? user.instrucciones.trim() : '');
    if (!instrucciones) return SYSTEM_PROMPT_BASE;
    return SYSTEM_PROMPT_BASE + '\n\n' +
        'Instrucciones personalizadas de la persona que te escribe (sobre ' +
        'como prefiere que le hables, tono, idioma, formato, etc. -- ' +
        'siguelas salvo que choquen con las reglas de arriba):\n' +
        instrucciones;
}

// Herramientas que la IA puede usar en cada respuesta: buscar en internet y
// abrir/leer paginas web, y correr codigo (Python/Bash) en un sandbox propio
// de Anthropic. Ambas las ejecuta la API del lado de Anthropic; nunca abren
// ni corren nada en este servidor.
const HERRAMIENTAS_IA = [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
    { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 10 },
    { type: 'code_execution_20250825', name: 'code_execution' }
];

// Solo la busqueda tiene costo aparte de los tokens ($10 cada 1.000 = $0,01,
// -> 10 creditos al tipo de cambio de Rapido). Leer una pagina (web_fetch) y
// correr codigo salen gratis -- code_execution tiene su propio cupo mensual
// de horas de Anthropic, muy por encima de lo que un chat como este va a
// usar, y web_fetch no cobra nada aparte de los tokens que consume.
const CREDITOS_POR_BUSQUEDA = 10;

// ---------------------------------------------------------------------------
// Buscar fotos reales (Serper.dev, resultados de Google Imagenes)
//
// A diferencia de web_search/web_fetch (que ejecuta Anthropic del otro lado),
// esta es una herramienta "de cliente": cuando la IA la pide, ESTE servidor
// tiene que buscar de verdad, meter el resultado de vuelta en la conversacion
// y volver a llamar a Claude -- por eso el ciclo de /api/chat tiene un lazo
// (verlo mas abajo), a diferencia de las herramientas server-side de arriba
// que resuelven todo en una sola llamada.
//
// web_fetch NO sirve para esto: solo devuelve texto/PDF, nunca URLs de
// imagenes (documentado por Anthropic) -- probado en produccion el 26 de
// agosto: el modelo admitio que no tenia ninguna URL de imagen real
// disponible pese a haber buscado. De ahi la necesidad de esta herramienta
// aparte.
//
// Se uso Serper.dev en vez de la API oficial de Google (Custom Search JSON
// API) porque Google la cerro a clientes nuevos -- probado el mismo 26 de
// agosto: con la cuenta de Google recien creada, cualquier busqueda daba 403
// "This project does not have the access to Custom Search JSON API",
// documentado por el propio foro de desarrolladores de Google, sin arreglo
// posible del lado de configuracion (ni facturacion, ni permisos, nada).
// Serper si acepta cuentas nuevas y devuelve los mismos resultados de Google.
// ---------------------------------------------------------------------------

const HERRAMIENTA_BUSCAR_IMAGEN = {
    name: 'buscar_imagen',
    description: 'Busca fotos reales en internet (Google Imagenes) sobre algo puntual -- una ' +
        'ciudad, un lugar, una persona publica, un animal, un objeto, etc. -- y devuelve ' +
        'URLs de imagenes reales y verificadas, listas para usar. Usala siempre que te ' +
        'pidan una imagen o foto de algo real; nunca inventes una URL por tu cuenta.',
    input_schema: {
        type: 'object',
        properties: {
            consulta: {
                type: 'string',
                description: 'Que buscar, en pocas palabras y en el idioma que mejor describa el ' +
                    'tema (ej: "ciudad de Neiva Huila Colombia").'
            }
        },
        required: ['consulta']
    }
};

const MAX_RESULTADOS_BUSCAR_IMAGEN = 5;

// Extensiones que de plano NO sirven (paginas, vectores, documentos) -- se
// usa como lista negra, no blanca: muchas imagenes de sitios buenos (p.ej.
// Unsplash) no tienen ninguna extension en la URL, solo un ID, y se
// descartaban todas por error cuando el filtro exigia una extension "buena".
// La descarga real (/api/descargar-imagen) de todas formas verifica el tipo
// de verdad por el Content-Type que responde el servidor, no por la URL.
const EXTENSIONES_IMAGEN_BLOQUEADAS = ['svg', 'html', 'htm', 'php', 'pdf', 'bmp', 'tiff', 'tif', 'ico'];

// Sin esto, Serper busca en TODA la web y trae fotos de sitios que bloquean
// "hotlinking" (cargar su imagen desde fuera de su propia pagina) -- se
// probo en producción el 26 de agosto: la imagen ni cargaba en el chat ni se
// podia descargar, aunque la URL en si era real. Estos sitios si dejan
// cargar sus imagenes desde cualquier lado, es parte de para que existen.
const SITIOS_IMAGEN_CONFIABLES = [
    'commons.wikimedia.org', 'upload.wikimedia.org', 'wikipedia.org',
    'unsplash.com', 'pexels.com', 'pixabay.com'
];
const FILTRO_SITIOS_CONFIABLES = SITIOS_IMAGEN_CONFIABLES.map((s) => 'site:' + s).join(' OR ');

// Wikipedia/Wikimedia a veces agregan parametros de rastreo (utm_source,
// utm_campaign...) a sus propias URLs de imagen -- probado en produccion el
// 26 de agosto: la imagen nunca cargo en el navegador de un usuario real
// pese a que la URL respondia perfecto por fuera (probable bloqueador de
// anuncios/privacidad, que bloquea por patron cualquier URL con "utm_*" sin
// importar que sea una imagen real). Se limpian esos parametros de rastreo
// antes de usar la URL; el resto de la query string (si la hay) se respeta.
const PARAMETROS_RASTREO = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
function limpiarUrlImagen(url) {
    try {
        const u = new URL(url);
        PARAMETROS_RASTREO.forEach((p) => u.searchParams.delete(p));
        return u.href;
    } catch (e) {
        return url;
    }
}

async function buscarImagenSerper(consulta) {
    const controlador = new AbortController();
    const tiempoAgotado = setTimeout(() => controlador.abort(), 10000);
    try {
        const consultaFinal = String(consulta || '').slice(0, 250) + ' (' + FILTRO_SITIOS_CONFIABLES + ')';
        const respuesta = await fetch('https://google.serper.dev/images', {
            method: 'POST',
            headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ q: consultaFinal, num: MAX_RESULTADOS_BUSCAR_IMAGEN * 2 }),
            signal: controlador.signal
        });
        if (!respuesta.ok) {
            const cuerpoError = await respuesta.text().catch(() => '');
            throw new Error('Serper respondio ' + respuesta.status + ': ' + cuerpoError.slice(0, 500));
        }
        const datos = await respuesta.json();
        const items = Array.isArray(datos.images) ? datos.images : [];
        const filtrados = items.filter((it) => {
            const ext = String(it.imageUrl || '').split('.').pop().split('?')[0].toLowerCase();
            return EXTENSIONES_IMAGEN_BLOQUEADAS.indexOf(ext) === -1;
        });
        const finales = filtrados.slice(0, MAX_RESULTADOS_BUSCAR_IMAGEN).map((it) => ({ url: limpiarUrlImagen(it.imageUrl), titulo: it.title || '' }));
        console.log('buscar_imagen "' + consulta + '": ' + items.length + ' resultados de Serper, ' + filtrados.length + ' pasaron el filtro. URLs devueltas:\n' +
            finales.map((f) => '  ' + f.url).join('\n'));
        return finales;
    } finally {
        clearTimeout(tiempoAgotado);
    }
}

// Precio real de Serper (plan de entrada): ~$3 USD cada 1.000 llamadas =
// $0,003 -> 3 creditos al tipo de cambio de Rapido. Mismo criterio que
// CREDITOS_POR_BUSQUEDA: se cobra al costo, sin margen aparte (el margen ya
// esta en el multiplicador de tokens de cada modelo).
const CREDITOS_POR_IMAGEN = 3;
const MAX_RONDAS_BUSCAR_IMAGEN = 3;

// Lista final que se le manda a Claude: las de siempre + buscar_imagen, solo
// si esta configurada (si no, ni se ofrece -- asi el modelo no puede
// "elegirla" y quedarse pegado esperando que exista).
const HERRAMIENTAS_PARA_CHAT = HERRAMIENTAS_IA.concat(IMAGEN_CONFIGURADA ? [HERRAMIENTA_BUSCAR_IMAGEN] : []);

// Imagenes adjuntas al chat (para que el usuario muestre capturas, disenos o
// mockups de su proyecto). Van directo en el mensaje como bloque "image", sin
// pasar por la Files API: mas simple, y no hay que limpiar archivos despues.
// Limites de la API de Claude: 10MB en base64, JPEG/PNG/GIF/WEBP.
const TIPOS_IMAGEN_PERMITIDOS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const MAX_BASE64_IMAGEN = 14 * 1024 * 1024; // ~10MB reales, con margen del inflado de base64

// PDF: va como bloque "document" nativo de la API, Claude lo lee de verdad
// (texto, tablas, incluso paginas escaneadas).
const MAX_BASE64_DOCUMENTO = 20 * 1024 * 1024; // ~15MB reales de PDF

// Archivos de texto/codigo: no hay bloque especial para esto, se pegan como
// texto plano dentro del mensaje (envueltos en un bloque de codigo) para que
// Claude los lea como parte de la conversacion.
const MAX_CARACTERES_ARCHIVO_TEXTO = 120000; // generoso mismo asi de sobra
const EXTENSIONES_TEXTO_PERMITIDAS = [
    'txt', 'md', 'csv', 'json', 'yml', 'yaml', 'xml', 'log',
    'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs',
    'go', 'rb', 'php', 'html', 'css', 'scss', 'sql', 'sh', 'env'
];

// Word (.docx) y Excel (.xlsx) tampoco tienen bloque nativo en la API de
// Claude: se convierten a texto plano del lado del servidor (mammoth para
// docx, exceljs para xlsx) y se pegan igual que un archivo de texto normal.
// Un .zip se abre con jszip y se leen los archivos de texto/codigo que traiga
// adentro (los binarios se ignoran), con el mismo tope de extensiones que
// EXTENSIONES_TEXTO_PERMITIDAS.
//
// Estas tres librerias se cargan con require() perezoso (cargarMammoth(),
// etc.) la PRIMERA VEZ que hace falta, no al arrancar el servidor: asi, si
// alguna llegara a fallar al cargar en el entorno real de produccion, se
// cae solo esa peticion puntual (con un error limpio) en vez de tumbar el
// servidor entero -- la leccion de los dos incidentes de despliegue de este
// mismo dia (streaming y la actualizacion del SDK) fue que un problema de
// arranque con una dependencia nueva puede dejar caida TODA la aplicacion.
const MAX_BASE64_OFICINA = 20 * 1024 * 1024; // .docx / .xlsx
const MAX_BASE64_ZIP = 25 * 1024 * 1024;
const MAX_ARCHIVOS_EN_ZIP = 20;

let mammothLib = null;
function cargarMammoth() { if (!mammothLib) mammothLib = require('mammoth'); return mammothLib; }
let ExcelJSLib = null;
function cargarExcelJS() { if (!ExcelJSLib) ExcelJSLib = require('exceljs'); return ExcelJSLib; }
let JSZipLib = null;
function cargarJSZip() { if (!JSZipLib) JSZipLib = require('jszip'); return JSZipLib; }

async function extraerTextoDocx(buffer) {
    const mammoth = cargarMammoth();
    const resultado = await mammoth.extractRawText({ buffer });
    return (resultado && resultado.value) || '';
}

async function extraerTextoXlsx(buffer) {
    const ExcelJS = cargarExcelJS();
    const libro = new ExcelJS.Workbook();
    await libro.xlsx.load(buffer);
    const partes = [];
    libro.eachSheet((hoja) => {
        partes.push('## Hoja: ' + hoja.name);
        hoja.eachRow((fila) => {
            const valores = fila.values.slice(1).map((v) => {
                if (v == null) return '';
                if (typeof v === 'object' && v.text != null) return String(v.text);
                if (typeof v === 'object' && v.result != null) return String(v.result);
                return String(v);
            });
            partes.push(valores.join(' | '));
        });
    });
    return partes.join('\n');
}

async function extraerTextoZip(buffer) {
    const JSZip = cargarJSZip();
    const zip = await JSZip.loadAsync(buffer);
    const partes = [];
    let procesados = 0;
    const nombres = Object.keys(zip.files);
    for (let i = 0; i < nombres.length && procesados < MAX_ARCHIVOS_EN_ZIP; i++) {
        const entrada = zip.files[nombres[i]];
        if (entrada.dir) continue;
        const ext = (nombres[i].split('.').pop() || '').toLowerCase();
        if (EXTENSIONES_TEXTO_PERMITIDAS.indexOf(ext) === -1) continue;
        const contenido = await entrada.async('string');
        partes.push('### Archivo: ' + nombres[i] + '\n' + contenido.slice(0, 20000));
        procesados++;
    }
    return partes.join('\n\n');
}

// Multiplicadores = precio de entrada de cada modelo dividido entre el de
// Rápido (Haiku, $1/MTok): Sonnet $2, Opus $5, Fable $10 -> 1 : 2(*) : 5 : 10.
// (*) Equilibrado quedó en 3x desde antes de que Sonnet bajara de precio; no
// se toca aca porque cambiar eso afecta el margen de cuentas ya existentes.
const MODELOS = {
    rapido:   { id: 'claude-haiku-4-5-20251001',  multiplicador: 1, etiqueta: 'Rápido (Haiku 4.5)'   },
    equilibrado: { id: 'claude-sonnet-5', multiplicador: 3, etiqueta: 'Equilibrado (Sonnet 5)' },
    avanzado: { id: 'claude-opus-5',      multiplicador: 5, etiqueta: 'Avanzado (Opus 5)' },
    maximo:   { id: 'claude-fable-5',     multiplicador: 10, etiqueta: 'Máximo (Fable 5)' }
};
const MODELO_POR_DEFECTO = 'rapido';

const CREDITOS_DE_BIENVENIDA = 100;

// Programa de referidos: mismo monto que el bono de bienvenida, para los
// dos lados. El tope es la unica proteccion real contra alguien creando
// muchas cuentas referidas para farmear creditos hacia una sola cuenta
// "referidora" -- el bono del REFERIDO se paga igual pase lo que pase (ese
// riesgo ya existe con cualquier registro nuevo, con o sin referidos, asi
// que no vale la pena bloquearlo aqui); lo que se topa es cuantas veces una
// misma cuenta puede cobrar por referir. Con 20 de tope, el peor caso de
// abuso cuesta unos $2.000 COP en creditos de mas -- nada grave.
const CREDITOS_BONO_REFERIDO = 100;
const MAX_REFERIDOS_CON_BONO = 20;
// Con herramientas de por medio (sobre todo code_execution generando codigo
// largo, como una pagina web completa) una respuesta puede necesitar mucho
// mas espacio de salida del que parece. En 4096 se estaba cortando a mitad
// de camino sin avisar -- el usuario veia "aqui voy..." y despues nada, sin
// forma de saber si seguia trabajando o se habia quedado pegado.
const MAX_TOKENS_RESPUESTA = 16384;
// Antes en 10: una conversacion un poco larga "olvidaba" el principio. En 30
// aguanta charlas mas largas sin perder contexto; el costo en tokens lo paga
// cada quien via creditos, asi que subirlo no le cuesta nada a la cuenta.
const MENSAJES_DE_HISTORIAL = 30;

const PAQUETES = {
    prueba:  { creditos: 400,   precioCOP: 9900,   nombre: 'Prueba'  },
    basico:  { creditos: 1200,  precioCOP: 24900,  nombre: 'Básico'  },
    popular: { creditos: 3000,  precioCOP: 54900,  nombre: 'Popular' },
    pro:     { creditos: 8000,  precioCOP: 129900, nombre: 'Pro'     }
};

// Respaldo a la regla de "cero emojis" del system prompt: el modelo (sobre
// todo Rapido) a veces la ignora igual, confirmado en produccion con
// pruebas reales. En vez de seguir peleando por prompt, se filtran ya
// generados -- garantizado, no depende de que el modelo obedezca.
const EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;
function quitarEmojis(texto) {
    return texto
        .replace(EMOJI_REGEX, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/[ \t]{2,}/g, ' ')
        .trimEnd();
}

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

// Los usuarios creados antes del programa de referidos no tienen codigo
// propio. Se les genera la primera vez que hace falta, igual que el saldo
// o la verificacion. El _id de Mongo ya es unico de por si, asi que tomar
// un pedazo del suyo evita tener que revisar colisiones contra la base.
async function asegurarCodigoReferido(users, user) {
    if (typeof user.codigoReferido === 'string' && user.codigoReferido) return user;
    const codigoReferido = user._id.toString().slice(-8);
    await users.updateOne({ _id: user._id }, { $set: { codigoReferido } });
    user.codigoReferido = codigoReferido;
    return user;
}

// Se llama cuando una cuenta referida queda verificada (al registrarse, si
// el correo esta apagado, o al hacer clic en el enlace de verificacion). El
// bono del referido se paga siempre -- ese riesgo de cuentas falsas ya
// existe con cualquier registro nuevo. Lo unico que se topa es cuantas
// veces cobra la cuenta que referio, con MAX_REFERIDOS_CON_BONO.
async function otorgarBonoReferidoSiAplica(users, referredUser) {
    if (!referredUser.referidoPor || referredUser.bonoReferidoPagado) return;
    await users.updateOne(
        { _id: referredUser._id },
        { $set: { bonoReferidoPagado: true }, $inc: { creditBalance: CREDITOS_BONO_REFERIDO } }
    );
    const referrer = await users.findOne({ _id: referredUser.referidoPor });
    if (!referrer || (referrer.referidosExitosos || 0) >= MAX_REFERIDOS_CON_BONO) return;
    await users.updateOne(
        { _id: referrer._id },
        {
            $inc: {
                creditBalance: CREDITOS_BONO_REFERIDO,
                referidosExitosos: 1,
                creditosGanadosPorReferidos: CREDITOS_BONO_REFERIDO
            }
        }
    );
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
// Un intercambio tipico ronda los 3,6 creditos en modo Rapido (ver
// CRED_POR_MSG en index.html) -- 30 creditos son mas o menos 8 mensajes de
// margen antes de quedarse sin nada, tiempo suficiente para que el correo
// llegue y la persona compre antes de toparse con el bloqueo de saldo.
const UMBRAL_SALDO_BAJO = 30;

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

function enviarSaldoBajo(req, destinatario, nombre, saldo) {
    const link = `${req.protocol}://${req.get('host')}/`;
    return enviarCorreo(
        destinatario,
        'Se te están acabando los créditos en LunaticoIA',
        `Hola${nombre ? ' ' + nombre : ''},\n\nTe quedan ${saldo} créditos en LunaticoIA. Cuando se acaben, ` +
            `el chat deja de responder hasta que compres más.\n\nCompra un paquete aquí (los créditos no caducan):\n${link}`,
        `<p>Hola${nombre ? ' ' + escHtml(nombre) : ''},</p>` +
            `<p>Te quedan <strong>${saldo} créditos</strong> en LunaticoIA. Cuando se acaben, el chat deja de responder hasta que compres más.</p>` +
            `<p><a href="${link}">Comprar más créditos</a> (no caducan).</p>`
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

const compartirLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiados links compartidos. Espera un poco.' }
});

const imagenLimiter = rateLimit({
    windowMs: 10 * 60 * 1000, max: 30,
    standardHeaders: true, legacyHeaders: false,
    message: { error: 'Demasiadas descargas de imagen. Espera un momento.' }
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

// manifest.json y sw.js son los dos únicos .json/.js que sí hacen falta
// servir de verdad (los necesita la PWA) -- todo lo demás con esas
// extensiones sigue bloqueado para no exponer server-saas.js, package.json,
// este mismo archivo, etc.
const PERMITIDOS_PWA = new Set(['/manifest.json', '/sw.js', '/.well-known/assetlinks.json']);
const BLOQUEADOS = /\.(js|json|md|bat|ps1|lock|yml|yaml)$/i;
app.use((req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    if (PERMITIDOS_PWA.has(req.path)) return next();
    if (BLOQUEADOS.test(req.path)) return res.status(404).end();
    next();
});

// Digital Asset Links: asi confirma Android que el TWA de Play y este
// dominio son la misma app, para que se abra sin barra de direcciones.
// No puede pasar por express.static de abajo: esa carpeta empieza con un
// punto (".well-known") y el estatico usa dotfiles:'ignore' a proposito
// (para no exponer .env, .git, etc. por accidente) -- se sirve aparte,
// embebido aqui en vez de leerlo de un archivo, porque solo cambia si se
// rota la llave de firma de la app (evento raro y manual).
const ASSETLINKS_TWA = [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: {
        namespace: 'android_app',
        package_name: 'uk.lunaticoia.twa',
        sha256_cert_fingerprints: ['23:DB:84:EF:0D:F4:EA:C6:E0:C9:4B:FE:8E:20:82:43:97:04:B7:3F:D5:7D:24:1A:3D:64:E5:9C:71:0B:C3:FC']
    }
}];
app.get('/.well-known/assetlinks.json', (req, res) => res.json(ASSETLINKS_TWA));

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
        const proyectos = db.collection('proyectos');
        const compartidos = db.collection('compartidos');

        await users.createIndex({ email: 1 }, { unique: true });
        await users.createIndex({ verificationToken: 1 }, { sparse: true });
        await users.createIndex({ resetToken: 1 }, { sparse: true });
        await users.createIndex({ codigoReferido: 1 }, { sparse: true });
        await messages.createIndex({ userId: 1, proyectoId: 1, createdAt: -1 });
        await compras.createIndex({ referencia: 1 }, { unique: true });
        await proyectos.createIndex({ userId: 1, createdAt: -1 });
        await compartidos.createIndex({ codigo: 1 }, { unique: true });

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

        // Programa de referidos: si trae un codigo valido, se guarda quien
        // refirio -- el bono se paga despues, cuando el correo quede
        // verificado (aca mismo si el correo esta apagado, o en
        // /api/verificar-correo). Un codigo invalido o inventado simplemente
        // se ignora, no rompe el registro.
        let referidoPor = null;
        if (typeof req.body.refCode === 'string' && req.body.refCode.trim()) {
            const referrer = await users.findOne({ codigoReferido: req.body.refCode.trim() });
            if (referrer) referidoPor = referrer._id;
        }

        // Sin correo configurado, nadie queda bloqueado: se da la cuenta por
        // verificada de una vez, igual que se hacía antes de esta función.
        const verificationToken = CORREO_CONFIGURADO ? generarToken() : null;
        const nuevoId = new ObjectId();
        const user = {
            _id: nuevoId,
            email: email.toLowerCase(),
            name: name || email.split('@')[0],
            password: hashed,
            creditBalance: CREDITOS_DE_BIENVENIDA,
            createdAt: new Date(),
            emailVerified: !CORREO_CONFIGURADO,
            verificationToken,
            verificationTokenExpira: CORREO_CONFIGURADO ? new Date(Date.now() + VENCIMIENTO_VERIFICACION_MS) : null,
            codigoReferido: nuevoId.toString().slice(-8),
            referidoPor,
            bonoReferidoPagado: false,
            referidosExitosos: 0,
            creditosGanadosPorReferidos: 0
        };

        await users.insertOne(user);
        if (user.emailVerified) {
            await otorgarBonoReferidoSiAplica(users, user);
            if (user.referidoPor) user.creditBalance += CREDITOS_BONO_REFERIDO;
        }

        const token = jwt.sign(
            { userId: nuevoId.toString(), email: user.email },
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
        user = await asegurarCodigoReferido(users, user);

        res.json({
            email: user.email,
            name: user.name || user.email.split('@')[0],
            creditBalance: user.creditBalance,
            creditosIlimitados: user.creditosIlimitados === true,
            creditosPorBusqueda: CREDITOS_POR_BUSQUEDA,
            emailVerified: user.emailVerified,
            correoConfigurado: CORREO_CONFIGURADO,
            instrucciones: typeof user.instrucciones === 'string' ? user.instrucciones : '',
            maxCaracteresInstrucciones: MAX_CARACTERES_INSTRUCCIONES,
            codigoReferido: user.codigoReferido,
            creditosBonoReferido: CREDITOS_BONO_REFERIDO,
            referidosExitosos: user.referidosExitosos || 0,
            creditosGanadosPorReferidos: user.creditosGanadosPorReferidos || 0,
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

// Panel de admin: reutiliza el mismo flag de creditosIlimitados (pensado
// para el creador de LunaticoIA) en vez de agregar un rol aparte -- en este
// SaaS de un solo dueno, "cuenta ilimitada" y "cuenta de administracion" son
// la misma persona. Nunca confiar en el frontend para esto: se valida aca.
app.get('/api/admin/usuarios', authenticateToken, async (req, res) => {
    try {
        const users = db.collection('users');
        const yo = await users.findOne({ _id: new ObjectId(req.user.userId) });
        if (!yo || yo.creditosIlimitados !== true) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        const todos = await users.find({}).sort({ createdAt: -1 }).toArray();
        const mensajes = await db.collection('messages').find({ role: 'assistant' }).toArray();

        const porUsuario = {};
        mensajes.forEach((m) => {
            const clave = (m.userId || '').toString();
            if (!porUsuario[clave]) porUsuario[clave] = {};
            const modeloUsado = m.modelo || 'desconocido';
            porUsuario[clave][modeloUsado] = (porUsuario[clave][modeloUsado] || 0) + 1;
        });

        res.json({
            usuarios: todos.map((u) => {
                const porModelo = porUsuario[u._id.toString()] || {};
                const totalMensajes = Object.values(porModelo).reduce((a, b) => a + b, 0);
                return {
                    email: u.email,
                    name: u.name || u.email.split('@')[0],
                    creditBalance: u.creditBalance,
                    creditosIlimitados: u.creditosIlimitados === true,
                    emailVerified: u.emailVerified === true,
                    createdAt: u.createdAt,
                    mensajesPorModelo: porModelo,
                    totalMensajes
                };
            })
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos cargar el panel de admin.', error, 'admin-usuarios');
    }
});

app.post('/api/instrucciones', authenticateToken, async (req, res) => {
    try {
        const texto = typeof req.body.instrucciones === 'string' ? req.body.instrucciones.trim() : '';
        if (texto.length > MAX_CARACTERES_INSTRUCCIONES) {
            return res.status(400).json({ error: 'Máximo ' + MAX_CARACTERES_INSTRUCCIONES + ' caracteres' });
        }
        const users = db.collection('users');
        const userId = new ObjectId(req.user.userId);
        await users.updateOne({ _id: userId }, { $set: { instrucciones: texto } });
        res.json({ instrucciones: texto });
    } catch (error) {
        fallo(res, 500, 'No pudimos guardar tus instrucciones.', error, 'instrucciones');
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
        await otorgarBonoReferidoSiAplica(users, user);

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
// Proyectos
//
// Cada usuario puede agrupar sus conversaciones en proyectos con nombre (como
// los "Proyectos" de Claude.ai), ademas del chat general de siempre (sin
// proyecto). Un mensaje sin proyectoId sigue siendo del chat general -- los
// mensajes de cuentas creadas antes de esta funcion tampoco tienen el campo,
// y Mongo trata "sin el campo" igual que "el campo en null" al consultar, asi
// que caen en el chat general automaticamente, sin migracion.
// ---------------------------------------------------------------------------

app.get('/api/proyectos', authenticateToken, async (req, res) => {
    try {
        const proyectos = db.collection('proyectos');
        const userId = new ObjectId(req.user.userId);
        const lista = await proyectos.find({ userId }).sort({ createdAt: -1 }).toArray();
        res.json({
            proyectos: lista.map((p) => ({
                id: p._id.toString(),
                nombre: p.nombre,
                createdAt: p.createdAt,
                instrucciones: typeof p.instrucciones === 'string' ? p.instrucciones : ''
            }))
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos cargar tus proyectos.', error, 'proyectos-listar');
    }
});

app.post('/api/proyectos', authenticateToken, async (req, res) => {
    try {
        const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
        if (!nombre) return res.status(400).json({ error: 'Ponle un nombre al proyecto' });
        if (nombre.length > MAX_CARACTERES_PROYECTO) {
            return res.status(400).json({ error: 'Máximo ' + MAX_CARACTERES_PROYECTO + ' caracteres' });
        }
        const proyectos = db.collection('proyectos');
        const userId = new ObjectId(req.user.userId);
        const createdAt = new Date();
        const r = await proyectos.insertOne({ userId, nombre, createdAt });
        res.status(201).json({ id: r.insertedId.toString(), nombre, createdAt });
    } catch (error) {
        fallo(res, 500, 'No pudimos crear el proyecto.', error, 'proyectos-crear');
    }
});

app.put('/api/proyectos/:id/instrucciones', authenticateToken, async (req, res) => {
    try {
        let proyectoId;
        try { proyectoId = new ObjectId(req.params.id); } catch (e) {
            return res.status(400).json({ error: 'Proyecto no válido' });
        }
        const texto = typeof req.body.instrucciones === 'string' ? req.body.instrucciones.trim() : '';
        if (texto.length > MAX_CARACTERES_INSTRUCCIONES) {
            return res.status(400).json({ error: 'Máximo ' + MAX_CARACTERES_INSTRUCCIONES + ' caracteres' });
        }
        const proyectos = db.collection('proyectos');
        const userId = new ObjectId(req.user.userId);
        const proyecto = await proyectos.findOne({ _id: proyectoId, userId });
        if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

        await proyectos.updateOne({ _id: proyectoId, userId }, { $set: { instrucciones: texto } });
        res.json({ instrucciones: texto });
    } catch (error) {
        fallo(res, 500, 'No pudimos guardar las instrucciones del proyecto.', error, 'proyectos-instrucciones');
    }
});

app.delete('/api/proyectos/:id', authenticateToken, async (req, res) => {
    try {
        let proyectoId;
        try { proyectoId = new ObjectId(req.params.id); } catch (e) {
            return res.status(400).json({ error: 'Proyecto no válido' });
        }
        const proyectos = db.collection('proyectos');
        const userId = new ObjectId(req.user.userId);
        const proyecto = await proyectos.findOne({ _id: proyectoId, userId });
        if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado' });

        await proyectos.deleteOne({ _id: proyectoId, userId });
        // Los mensajes del proyecto se quedan en la base (por si acaso), pero
        // huerfanos: como ya no hay proyecto que los liste, simplemente dejan
        // de ser visibles. No se borran para no perder historial por error.
        res.json({ eliminado: true });
    } catch (error) {
        fallo(res, 500, 'No pudimos eliminar el proyecto.', error, 'proyectos-eliminar');
    }
});

// Historial visual de una conversacion (general si no se manda proyectoId,
// o de un proyecto puntual). Separado de la logica de /api/chat porque ahi
// el historial se arma para mandarselo a Claude, no para pintarlo en pantalla.
app.get('/api/mensajes', authenticateToken, async (req, res) => {
    try {
        const userId = new ObjectId(req.user.userId);
        let proyectoId = null;
        if (req.query.proyectoId) {
            try { proyectoId = new ObjectId(req.query.proyectoId); } catch (e) {
                return res.status(400).json({ error: 'Proyecto no válido' });
            }
            const proyectos = db.collection('proyectos');
            const existe = await proyectos.findOne({ _id: proyectoId, userId });
            if (!existe) return res.status(404).json({ error: 'Proyecto no encontrado' });
        }

        const messages = db.collection('messages');
        const historial = await messages
            .find({ userId, proyectoId })
            .sort({ createdAt: -1, _id: -1 })
            .limit(MENSAJES_POR_HISTORIAL_VISUAL)
            .toArray();

        res.json({
            mensajes: historial.reverse().map((m) => {
                // El contenido puede ser texto plano o (si el turno tuvo
                // imagen/PDF) una lista de bloques -- para pintar en pantalla
                // solo hace falta el texto; el archivo en si no se re-manda.
                const esBloques = Array.isArray(m.content);
                const texto = esBloques
                    ? (m.content.find((b) => b.type === 'text') || {}).text || ''
                    : m.content;
                return {
                    role: m.role,
                    texto: texto,
                    tuvoAdjunto: esBloques && m.content.some((b) => b.type === 'image' || b.type === 'document'),
                    createdAt: m.createdAt
                };
            })
        });
    } catch (error) {
        fallo(res, 500, 'No pudimos cargar la conversación.', error, 'mensajes-historial');
    }
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

app.post('/api/chat', chatLimiter, authenticateToken, async (req, res) => {
    try {
        const { message, imagen, documento, archivoTexto, archivoOficina, archivoZip } = req.body;
        const claveModelo = req.body.modelo || MODELO_POR_DEFECTO;
        let mensajeTexto = typeof message === 'string' ? message.trim() : '';

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

        let documentoValido = null;
        if (documento != null) {
            if (
                typeof documento !== 'object' ||
                documento.mediaType !== 'application/pdf' ||
                typeof documento.datos !== 'string' ||
                !documento.datos ||
                documento.datos.length > MAX_BASE64_DOCUMENTO
            ) {
                return res.status(400).json({ error: 'PDF no válido' });
            }
            documentoValido = {
                mediaType: documento.mediaType,
                datos: documento.datos,
                nombre: typeof documento.nombre === 'string' ? documento.nombre.slice(0, 200) : 'documento.pdf'
            };
        }

        // Sin bloque nativo para esto: se pega como texto dentro del mensaje,
        // envuelto en un bloque de codigo con el nombre del archivo delante.
        if (archivoTexto != null) {
            if (
                typeof archivoTexto !== 'object' ||
                typeof archivoTexto.contenido !== 'string' ||
                !archivoTexto.contenido ||
                archivoTexto.contenido.length > MAX_CARACTERES_ARCHIVO_TEXTO
            ) {
                return res.status(400).json({ error: 'Archivo de texto no válido' });
            }
            const nombreArchivo = typeof archivoTexto.nombre === 'string' ? archivoTexto.nombre.slice(0, 200) : 'archivo.txt';
            mensajeTexto = 'Archivo adjunto "' + nombreArchivo + '":\n```\n' + archivoTexto.contenido + '\n```\n\n' + mensajeTexto;
        }

        // Word (.docx) y Excel (.xlsx): se convierten a texto plano aca en el
        // servidor y se pegan igual que un archivo de texto normal. Si la
        // conversion falla (archivo corrupto, formato raro) se rechaza con un
        // 400 limpio -- nunca se deja que reviente sin control.
        if (archivoOficina != null) {
            if (
                typeof archivoOficina !== 'object' ||
                ['docx', 'xlsx'].indexOf(archivoOficina.tipo) === -1 ||
                typeof archivoOficina.datos !== 'string' ||
                !archivoOficina.datos ||
                archivoOficina.datos.length > MAX_BASE64_OFICINA
            ) {
                return res.status(400).json({ error: 'Archivo de Word/Excel no válido' });
            }
            const nombreOficina = typeof archivoOficina.nombre === 'string' ? archivoOficina.nombre.slice(0, 200) : 'archivo';
            let textoExtraido;
            try {
                const buffer = Buffer.from(archivoOficina.datos, 'base64');
                textoExtraido = archivoOficina.tipo === 'docx' ? await extraerTextoDocx(buffer) : await extraerTextoXlsx(buffer);
            } catch (errorExtraccion) {
                console.error('✗ archivo-oficina:', errorExtraccion && errorExtraccion.message);
                return res.status(400).json({ error: 'No pudimos leer ese archivo. ¿Seguro que es un ' + archivoOficina.tipo + ' válido?' });
            }
            textoExtraido = textoExtraido.slice(0, MAX_CARACTERES_ARCHIVO_TEXTO);
            mensajeTexto = 'Archivo adjunto "' + nombreOficina + '":\n```\n' + textoExtraido + '\n```\n\n' + mensajeTexto;
        }

        // .zip: se abren solo los archivos de texto/codigo que traiga adentro
        // (los binarios se ignoran), con el mismo tope de MAX_ARCHIVOS_EN_ZIP.
        if (archivoZip != null) {
            if (
                typeof archivoZip !== 'object' ||
                typeof archivoZip.datos !== 'string' ||
                !archivoZip.datos ||
                archivoZip.datos.length > MAX_BASE64_ZIP
            ) {
                return res.status(400).json({ error: 'Archivo .zip no válido' });
            }
            const nombreZip = typeof archivoZip.nombre === 'string' ? archivoZip.nombre.slice(0, 200) : 'archivo.zip';
            let textoExtraido;
            try {
                const buffer = Buffer.from(archivoZip.datos, 'base64');
                textoExtraido = await extraerTextoZip(buffer);
            } catch (errorExtraccion) {
                console.error('✗ archivo-zip:', errorExtraccion && errorExtraccion.message);
                return res.status(400).json({ error: 'No pudimos leer ese .zip. ¿Seguro que no está dañado?' });
            }
            if (!textoExtraido) {
                return res.status(400).json({ error: 'Ese .zip no trae ningún archivo de texto/código legible.' });
            }
            textoExtraido = textoExtraido.slice(0, MAX_CARACTERES_ARCHIVO_TEXTO);
            mensajeTexto = 'Archivo adjunto "' + nombreZip + '" (contenido de texto extraído):\n' + textoExtraido + '\n\n' + mensajeTexto;
        }

        if (!mensajeTexto && !imagenValida && !documentoValido) {
            return res.status(400).json({ error: 'Message cannot be empty' });
        }
        if (!MODELOS[claveModelo]) {
            return res.status(400).json({ error: 'Modelo no válido' });
        }
        const modelo = MODELOS[claveModelo];

        const users = db.collection('users');
        const messages = db.collection('messages');
        const proyectosCol = db.collection('proyectos');
        const userId = new ObjectId(req.user.userId);

        // proyectoId null = chat general (de siempre). Si viene uno, tiene
        // que existir y ser del usuario -- si no, mejor rechazar que guardar
        // el mensaje en un proyecto ajeno o inexistente.
        let proyectoId = null;
        let proyectoActual = null;
        if (req.body.proyectoId) {
            try { proyectoId = new ObjectId(req.body.proyectoId); } catch (e) {
                return res.status(400).json({ error: 'Proyecto no válido' });
            }
            proyectoActual = await proyectosCol.findOne({ _id: proyectoId, userId });
            if (!proyectoActual) return res.status(404).json({ error: 'Proyecto no encontrado' });
        }

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
            .find({ userId, proyectoId })
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

        // Los adjuntos (imagen/PDF) quedan guardados en Mongo con su base64
        // completo para que Claude los "recuerde" dentro de la ventana de
        // historial -- pero volver a mandarlos TODOS en cada peticion, hasta
        // MENSAJES_DE_HISTORIAL mensajes hacia atras, puede sumar decenas de
        // MB si hubo varios adjuntos en la conversacion, y la API de Claude
        // rechaza peticiones muy pesadas. Por eso solo se re-manda completo
        // el adjunto MAS RECIENTE del historial; los demas se reducen a un
        // texto plano -- el binario sigue intacto en Mongo, solo no se
        // vuelve a mandar cada vez.
        let yaSeMandoUnAdjuntoDelHistorial = false;
        for (let i = messagesForClaude.length - 1; i >= 0; i--) {
            const contenido = messagesForClaude[i].content;
            if (!Array.isArray(contenido)) continue;
            if (!yaSeMandoUnAdjuntoDelHistorial) {
                yaSeMandoUnAdjuntoDelHistorial = true;
                continue;
            }
            const textoBloque = (contenido.find((b) => b.type === 'text') || {}).text || '';
            const tuvoImagen = contenido.some((b) => b.type === 'image');
            const tuvoDocumento = contenido.some((b) => b.type === 'document');
            const aviso = tuvoImagen ? '[imagen adjunta] ' : tuvoDocumento ? '[PDF adjunto] ' : '';
            messagesForClaude[i].content = aviso + textoBloque;
        }

        // La imagen/PDF van antes del texto (asi rinde mejor, segun la propia
        // guia de Anthropic) y como bloques, no como string; sin adjuntos se
        // manda el texto solo, igual que antes.
        let contenidoUsuario = mensajeTexto;
        if (imagenValida || documentoValido) {
            contenidoUsuario = [];
            if (imagenValida) {
                contenidoUsuario.push({ type: 'image', source: { type: 'base64', media_type: imagenValida.mediaType, data: imagenValida.datos } });
            }
            if (documentoValido) {
                contenidoUsuario.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: documentoValido.datos } });
            }
            contenidoUsuario.push({ type: 'text', text: mensajeTexto || 'Mira este archivo.' });
        }
        messagesForClaude.push({ role: 'user', content: contenidoUsuario });

        // Streaming por SSE, encendido recien cuando llega el primer texto de
        // verdad (no al arrancar la llamada): si Claude falla antes de eso
        // (clave invalida, etc.) el error sigue saliendo como JSON normal con
        // su status, igual que con .create() -- no se cambia ese contrato.
        // Si ya se mando texto y algo se rompe a mitad de camino, el catch de
        // abajo lo nota por res.headersSent y cierra el SSE con un evento de
        // error, sin cobrar credito (el cobro solo pasa despues de esta linea).
        let sseIniciado = false;
        function iniciarSSE() {
            if (sseIniciado) return;
            sseIniciado = true;
            res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
        }

        // buscar_imagen es una herramienta "de cliente": a diferencia de
        // web_search/web_fetch/code_execution (que Anthropic ejecuta solo de
        // su lado), cuando Claude la pide este servidor tiene que buscar de
        // verdad, devolverle el resultado en un tool_result, y volver a
        // llamarlo -- por eso este lazo, en vez de una sola llamada. Tope de
        // MAX_RONDAS_BUSCAR_IMAGEN + 1 llamadas totales a la API para que
        // nunca quede dando vueltas sin fin ni disparando el gasto.
        let mensajesRonda = messagesForClaude;
        let aiMessage = '';
        let response = null;
        let imagenesLlamadas = 0;
        const usoAcumulado = { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 } };
        const MAX_RONDAS_TOTAL = MAX_RONDAS_BUSCAR_IMAGEN + 1;

        for (let ronda = 1; ronda <= MAX_RONDAS_TOTAL; ronda++) {
            const stream = claudeClient.messages.stream({
                model: modelo.id,
                max_tokens: MAX_TOKENS_RESPUESTA,
                system: construirSystemPrompt(user, proyectoActual),
                messages: mensajesRonda,
                tools: HERRAMIENTAS_PARA_CHAT
            });
            stream.on('text', (delta) => {
                iniciarSSE();
                res.write('data: ' + JSON.stringify({ delta }) + '\n\n');
            });

            response = await stream.finalMessage();

            // Con herramientas de por medio la respuesta trae varios bloques
            // de texto intercalados con los de busqueda/lectura/codigo (p.ej.
            // "voy a buscar..." + resultados + la respuesta final): hay que
            // juntarlos todos, no solo quedarse con el primero. Se van
            // acumulando a traves de las rondas tambien.
            if (response.content && Array.isArray(response.content)) {
                aiMessage += response.content.filter((i) => i.type === 'text').map((i) => i.text).join('');
            }

            const usoRonda = response.usage || {};
            usoAcumulado.input_tokens += usoRonda.input_tokens || 0;
            usoAcumulado.output_tokens += usoRonda.output_tokens || 0;
            usoAcumulado.server_tool_use.web_search_requests += (usoRonda.server_tool_use && usoRonda.server_tool_use.web_search_requests) || 0;
            usoAcumulado.server_tool_use.web_fetch_requests += (usoRonda.server_tool_use && usoRonda.server_tool_use.web_fetch_requests) || 0;

            const contenidoRonda = Array.isArray(response.content) ? response.content : [];
            const llamadasImagen = contenidoRonda.filter((b) => b.type === 'tool_use' && b.name === 'buscar_imagen');
            if (!llamadasImagen.length) break; // respuesta final normal, sin pedir mas herramientas
            if (ronda === MAX_RONDAS_TOTAL) break; // se acabaron las rondas -- se corta aca, sin resolver el tool_use pendiente

            mensajesRonda = mensajesRonda.concat([{ role: 'assistant', content: contenidoRonda }]);
            const resultadosTool = await Promise.all(llamadasImagen.map(async (llamada) => {
                imagenesLlamadas++;
                const consulta = (llamada.input && llamada.input.consulta) || '';
                try {
                    const resultados = await buscarImagenSerper(consulta);
                    const texto = resultados.length
                        ? 'Resultados de imagenes para "' + consulta + '":\n' +
                            resultados.map((r, idx) => (idx + 1) + '. ' + r.url + (r.titulo ? ' -- "' + r.titulo + '"' : '')).join('\n')
                        : 'No se encontraron fotos reales para esa busqueda.';
                    return { type: 'tool_result', tool_use_id: llamada.id, content: texto };
                } catch (errorBusqueda) {
                    console.error('✗ buscar_imagen:', (errorBusqueda && errorBusqueda.message) || errorBusqueda);
                    return {
                        type: 'tool_result', tool_use_id: llamada.id, is_error: true,
                        content: 'La busqueda de imagenes fallo por un problema tecnico. Avisale a la persona que no se pudo buscar la foto ahora mismo.'
                    };
                }
            }));
            mensajesRonda = mensajesRonda.concat([{ role: 'user', content: resultadosTool }]);
        }

        // El system prompt ya pide "cero emojis" por defecto, pero el modelo
        // (sobre todo Rapido) a veces los pone igual -- se filtran aca como
        // respaldo garantizado. Se respeta si la persona pidio otro tono
        // (con emojis, etc.) en sus instrucciones personalizadas -- mismo
        // criterio que usa construirSystemPrompt para decidir si aplican.
        const tieneInstruccionesPropias = !!(
            (proyectoActual && typeof proyectoActual.instrucciones === 'string' && proyectoActual.instrucciones.trim()) ||
            (user && typeof user.instrucciones === 'string' && user.instrucciones.trim())
        );
        if (!tieneInstruccionesPropias) aiMessage = quitarEmojis(aiMessage);

        // Si la respuesta se corto (llego al limite de tokens, Anthropic la
        // pauso a mitad de una busqueda/ejecucion de codigo larga, o se
        // agotaron las rondas de buscar_imagen sin llegar a una respuesta
        // final) el usuario se quedaba viendo un mensaje a medias sin ninguna
        // pista de que paso -- como si la IA se hubiera quedado pegada. Se
        // avisa explicito.
        const rondasAgotadas = response.stop_reason === 'tool_use';
        const cortada = response.stop_reason === 'max_tokens' || response.stop_reason === 'pause_turn' || rondasAgotadas;
        if (!aiMessage && !cortada) throw new Error('Invalid response from Claude API');
        if (cortada) {
            aiMessage += (aiMessage ? '\n\n' : '') + '⚠️ *La respuesta se cortó antes de terminar' +
                (response.stop_reason === 'max_tokens' ? ' (llegó al límite de longitud)'
                    : rondasAgotadas ? ' (se hicieron demasiadas búsquedas de imagen en un mismo mensaje)'
                    : ' (una búsqueda o ejecución de código larga quedó a medias)') +
                '. Escribe "continúa" para que siga.*';
        }

        // Se cobra DESPUÉS de una respuesta correcta: si la API falla, el
        // usuario no pierde saldo. Las cuentas con creditosIlimitados nunca
        // bajan de saldo (pensadas para el propio creador de LunaticoIA).
        // Las busquedas de imagen se cobran aparte porque Serper cobra por
        // fuera de Anthropic, igual que CREDITOS_POR_BUSQUEDA con web_search.
        const cobro = creditosDe(usoAcumulado, modelo.multiplicador) + imagenesLlamadas * CREDITOS_POR_IMAGEN;
        const nuevoSaldo = ilimitado ? user.creditBalance : Math.max(0, user.creditBalance - cobro);

        // Se guarda el mismo contenido que se le mando a Claude (con imagen o
        // PDF incluidos si los hubo): asi, mientras el turno siga dentro de
        // la ventana de historial (MENSAJES_DE_HISTORIAL), Claude los sigue
        // "viendo" en los siguientes mensajes de la misma conversacion.
        const guardadoEn = new Date();
        await messages.insertOne({
            userId, proyectoId, role: 'user',
            content: contenidoUsuario,
            createdAt: guardadoEn
        });
        await messages.insertOne({
            userId, proyectoId, role: 'assistant', content: aiMessage,
            modelo: claveModelo,
            createdAt: new Date(guardadoEn.getTime() + 1)
        });

        if (!ilimitado) {
            await users.updateOne({ _id: userId }, { $set: { creditBalance: nuevoSaldo } });
            // Aviso de saldo bajo: solo en el momento exacto en que CRUZA el
            // umbral hacia abajo (antes estaba por encima, ahora por debajo),
            // no en cada mensaje mientras siga bajo -- si no, mandaria el
            // mismo correo una y otra vez. Si despues compra mas y lo vuelve
            // a gastar, cruza otra vez y le llega el aviso de nuevo, que es
            // justo lo que se quiere. No bloquea la respuesta al usuario: si
            // el correo falla o tarda, no le afecta el chat (enviarCorreo ya
            // atrapa sus propios errores).
            if (user.creditBalance >= UMBRAL_SALDO_BAJO && nuevoSaldo < UMBRAL_SALDO_BAJO) {
                enviarSaldoBajo(req, user.email, user.name, nuevoSaldo);
            }
        }

        res.write('data: ' + JSON.stringify({
            done: true,
            response: aiMessage,
            consumo: {
                modelo: modelo.etiqueta,
                tokensEntrada: usoAcumulado.input_tokens,
                tokensSalida: usoAcumulado.output_tokens,
                busquedas: usoAcumulado.server_tool_use.web_search_requests,
                lecturasWeb: usoAcumulado.server_tool_use.web_fetch_requests,
                imagenes: imagenesLlamadas,
                creditosCobrados: cobro,
                creditBalance: nuevoSaldo,
                creditosIlimitados: ilimitado,
                cortada: cortada
            }
        }) + '\n\n');
        res.end();
    } catch (error) {
        if (res.headersSent) {
            // Ya se le mando texto real al cliente (el SSE esta abierto): no se
            // puede cambiar el status ahora, asi que el error viaja como evento
            // SSE. El cobro y el guardado en Mongo, arriba, nunca se alcanzaron
            // -- no se descuenta credito, igual que si hubiera fallado antes.
            console.error('✗ chat (streaming):', (error && error.message) || error);
            try {
                res.write('data: ' + JSON.stringify({
                    error: 'La respuesta se interrumpió a mitad de camino. No se te descontó ningún crédito.'
                }) + '\n\n');
            } catch (e2) { /* la conexion ya pudo haberse caido */ }
            try { res.end(); } catch (e3) { /* idem */ }
        } else {
            fallo(res, 500, 'No pudimos generar la respuesta. No se te descontó ningún crédito.', error, 'chat');
        }
    }
});

// ---------------------------------------------------------------------------
// Compartir respuestas
//
// Snapshot aparte de la pregunta+respuesta, en su propia coleccion -- nunca
// expone messages (el resto de la conversacion de nadie) a traves de un
// endpoint publico. El texto se acepta tal cual lo manda el cliente (ya lo
// genero la propia cuenta con sus creditos, no hay nada que verificar contra
// la base) pero se topa en longitud, y GET es de lectura publica: no
// necesita sesion, es justo el link que se comparte por WhatsApp.
// ---------------------------------------------------------------------------

const MAX_CARACTERES_COMPARTIR = 6000;

app.post('/api/compartir', compartirLimiter, authenticateToken, async (req, res) => {
    try {
        const mensajeUsuario = typeof req.body.mensajeUsuario === 'string'
            ? req.body.mensajeUsuario.trim().slice(0, MAX_CARACTERES_COMPARTIR) : '';
        const respuestaIA = typeof req.body.respuestaIA === 'string'
            ? req.body.respuestaIA.trim().slice(0, MAX_CARACTERES_COMPARTIR) : '';
        if (!respuestaIA) return res.status(400).json({ error: 'No hay nada que compartir' });

        const compartidos = db.collection('compartidos');
        const nuevoId = new ObjectId();
        const codigo = nuevoId.toString().slice(-10);
        await compartidos.insertOne({
            _id: nuevoId,
            codigo,
            userId: new ObjectId(req.user.userId),
            mensajeUsuario,
            respuestaIA,
            createdAt: new Date()
        });

        res.json({ codigo, link: `${req.protocol}://${req.get('host')}/?compartido=${codigo}` });
    } catch (error) {
        fallo(res, 500, 'No pudimos generar el link para compartir.', error, 'compartir');
    }
});

app.get('/api/compartido/:codigo', async (req, res) => {
    try {
        const compartidos = db.collection('compartidos');
        const doc = await compartidos.findOne({ codigo: req.params.codigo });
        if (!doc) return res.status(404).json({ error: 'Este link ya no está disponible.' });
        res.json({ mensajeUsuario: doc.mensajeUsuario, respuestaIA: doc.respuestaIA, creadoEn: doc.createdAt });
    } catch (error) {
        fallo(res, 500, 'No pudimos cargar esta respuesta compartida.', error, 'compartido');
    }
});

// ---------------------------------------------------------------------------
// Descargar una imagen que la IA encontro en la web (boton "Descargar
// imagen" del chat). Pasa por el servidor -- no directo del navegador al
// sitio de origen -- para poder forzar la descarga (Content-Disposition)
// aunque ese sitio no lo permita, y para no exponerle la URL cruda al
// navegador de quien la pide. Bloquea IPs privadas/locales para que esto no
// sirva de puente hacia la red interna de Railway u otros servicios.
// ---------------------------------------------------------------------------

const EXTENSION_POR_TIPO_IMAGEN = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'
};
const MAX_BYTES_IMAGEN_DESCARGA = 15 * 1024 * 1024;

function hostPrivadoOLocal(hostname) {
    const h = hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true;
    // IPv4 privada/loopback/enlace-local, e IPv6 loopback/enlace-local (::1, fe80::, fc00::/7)
    return /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
        h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd');
}

app.get('/api/descargar-imagen', imagenLimiter, authenticateToken, async (req, res) => {
    const urlCruda = req.query.url;
    let destino;
    try {
        destino = new URL(String(urlCruda || ''));
    } catch (e) {
        return res.status(400).json({ error: 'URL de imagen inválida.' });
    }
    if (destino.protocol !== 'https:' && destino.protocol !== 'http:') {
        return res.status(400).json({ error: 'URL de imagen inválida.' });
    }
    if (hostPrivadoOLocal(destino.hostname)) {
        return res.status(400).json({ error: 'Esa dirección no está permitida.' });
    }

    const controlador = new AbortController();
    const tiempoAgotado = setTimeout(() => controlador.abort(), 10000);
    try {
        const respuestaOrigen = await fetch(destino.href, { signal: controlador.signal, redirect: 'follow' });
        clearTimeout(tiempoAgotado);
        if (!respuestaOrigen.ok) {
            return res.status(502).json({ error: 'No pudimos descargar esa imagen.' });
        }
        const tipo = (respuestaOrigen.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        const extension = EXTENSION_POR_TIPO_IMAGEN[tipo];
        if (!extension) {
            return res.status(415).json({ error: 'Ese enlace no es una imagen descargable.' });
        }
        const largo = Number(respuestaOrigen.headers.get('content-length') || 0);
        if (largo && largo > MAX_BYTES_IMAGEN_DESCARGA) {
            return res.status(413).json({ error: 'Esa imagen es demasiado grande.' });
        }

        res.setHeader('Content-Type', tipo);
        res.setHeader('Content-Disposition', `attachment; filename="lunaticoia.${extension}"`);

        let recibidos = 0;
        for await (const trozo of respuestaOrigen.body) {
            recibidos += trozo.length;
            if (recibidos > MAX_BYTES_IMAGEN_DESCARGA) {
                res.destroy();
                return;
            }
            res.write(trozo);
        }
        res.end();
    } catch (error) {
        clearTimeout(tiempoAgotado);
        // error.cause trae la razon real (DNS, TLS, conexion rechazada, etc.)
        // -- "fetch failed" solo no dice nada util para diagnosticar.
        if (error && error.cause) console.error('  causa:', error.cause.message || error.cause);
        if (!res.headersSent) fallo(res, 502, 'No pudimos descargar esa imagen.', error, 'descargar-imagen');
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
