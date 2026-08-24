// Ajustes que dependen de DONDE se ejecutan las pruebas.
//
// Antes estaban escritos a mano y solo valian dentro del contenedor Linux:
// el navegador en /opt/pw-browsers/chromium y las capturas en
// /home/claude/entrega/. En Windows eso fallaba antes de empezar.
//
// Ahora: si ese chromium existe se usa, y si no se deja que Playwright
// busque el suyo. Las capturas van a pruebas/capturas/, al lado de aqui.
const fs = require('fs');
const path = require('path');

const CHROMIUM_DEL_CONTENEDOR = '/opt/pw-browsers/chromium';
const CARPETA_CAPTURAS = path.join(__dirname, 'capturas');

// Opciones para chromium.launch(). Solo fija executablePath si ese binario
// esta realmente ahi; en cualquier otro equipo Playwright resuelve solo.
function opcionesNavegador(extra) {
    const o = Object.assign({}, extra || {});
    if (fs.existsSync(CHROMIUM_DEL_CONTENEDOR)) {
        o.executablePath = CHROMIUM_DEL_CONTENEDOR;
    }
    return o;
}

// Ruta donde guardar una captura, creando la carpeta si hace falta.
function captura(nombre) {
    fs.mkdirSync(CARPETA_CAPTURAS, { recursive: true });
    return path.join(CARPETA_CAPTURAS, nombre);
}

module.exports = { opcionesNavegador, captura, CARPETA_CAPTURAS };
