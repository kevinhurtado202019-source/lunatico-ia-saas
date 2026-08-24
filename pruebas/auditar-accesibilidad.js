const { chromium } = require('playwright');
const entorno = require('./entorno');
const fake = require('./fake-mongo');
require.cache[require.resolve('mongodb')] = { id:'m', filename:'m', loaded:true, exports:fake, paths:[] };
function A(){ this.messages={ create: async p => ({
  content:[{type:'text',text:'Respuesta de prueba.'}], usage:{input_tokens:1600,output_tokens:400}, model:p.model }) }; }
A.default=A;
require.cache[require.resolve('@anthropic-ai/sdk')] = { id:'a', filename:'a', loaded:true, exports:A, paths:[] };
const PORT=4911;
Object.assign(process.env,{MONGODB_URI:'mongodb://f/l',JWT_SECRET:'s',CLAUDE_API_KEY:'k',
  WOMPI_PUBLIC_KEY:'p',WOMPI_INTEGRITY_SECRET:'i',WOMPI_EVENTS_SECRET:'e',PORT:String(PORT)});
require('../server-saas.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const CONTRASTE = `
(() => {
  function lum(c){
    const m = c.match(/[\\d.]+/g).map(Number);
    const [r,g,b] = m.slice(0,3).map(v => { v/=255; return v<=0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055,2.4); });
    return 0.2126*r + 0.7152*g + 0.0722*b;
  }
  function fondoReal(el){
    let n = el;
    while (n && n !== document.documentElement) {
      const bg = getComputedStyle(n).backgroundColor;
      if (bg && !/rgba\\(0, 0, 0, 0\\)|transparent/.test(bg)) return bg;
      n = n.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  }
  const malos = [];
  const vistos = new Set();
  document.querySelectorAll('*').forEach(el => {
    if (!el.offsetParent && el.tagName !== 'BODY') return;
    const t = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim()).map(n=>n.textContent.trim()).join(' ');
    if (!t) return;
    const cs = getComputedStyle(el);
    const px = parseFloat(cs.fontSize);
    const grande = px >= 24 || (px >= 18.66 && parseInt(cs.fontWeight) >= 700);
    const min = grande ? 3 : 4.5;
    const L1 = lum(cs.color), L2 = lum(fondoReal(el));
    const ratio = (Math.max(L1,L2)+0.05)/(Math.min(L1,L2)+0.05);
    if (ratio < min) {
      const k = el.className + '|' + Math.round(px);
      if (vistos.has(k)) return;
      vistos.add(k);
      malos.push({ sel: (el.className||el.tagName).toString().split(' ')[0], px: Math.round(px*10)/10,
                   ratio: Math.round(ratio*100)/100, min, txt: t.slice(0,42) });
    }
  });
  return malos;
})()
`;

(async () => {
  for(let i=0;i<60;i++){ try{ if((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; }catch(e){} await sleep(200); }
  const b = await chromium.launch(entorno.opcionesNavegador());
  const out = {};

  // ---- landing ----
  let pg = await b.newPage({ viewport:{width:1366,height:900} });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'networkidle' });
  await pg.waitForSelector('#listaPrecios .plan');
  out.contrasteLanding = await pg.evaluate(CONTRASTE);
  out.a11yLanding = await pg.evaluate(() => {
    const r = {};
    r.botonesSinNombre = [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent && !b.textContent.trim() && !b.getAttribute('aria-label')).length;
    r.imgSinAlt = [...document.querySelectorAll('img:not([alt])')].length;
    r.idioma = document.documentElement.lang || '(sin lang)';
    r.h1 = document.querySelectorAll('h1').length;
    r.tituloPagina = document.title;
    r.descripcion = (document.querySelector('meta[name=description]')||{}).content || '(sin meta description)';
    r.svgSinAria = [...document.querySelectorAll('svg')].filter(s => !s.getAttribute('aria-hidden') && !s.getAttribute('role')).length;
    return r;
  });

  // ---- app ----
  await pg.click('.lp-nav button.btn-luna');
  await pg.fill('#nombreCrear','Kevin');
  await pg.fill('#correoCrear', `a-${Date.now()}@t.local`);
  await pg.fill('#claveCrear','ClaveLarga123');
  await pg.click('#btnCrear');
  await pg.waitForTimeout(1600);

  // palabra kilometrica
  await pg.fill('#entrada','a'.repeat(300));
  await pg.press('#entrada','Enter');
  await pg.waitForTimeout(2200);
  out.desbordePalabraLarga = await pg.evaluate(() => {
    const t = document.querySelector('.turno.yo .texto');
    const h = document.getElementById('hilo');
    return t.getBoundingClientRect().right > h.getBoundingClientRect().right + 1
        || document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });

  out.contrasteApp = await pg.evaluate(CONTRASTE);
  out.a11yApp = await pg.evaluate(() => ({
    botonesSinNombre: [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent && !b.textContent.trim() && !b.getAttribute('aria-label')).length,
    textareaSinEtiqueta: !document.querySelector('label[for=entrada]') && !document.getElementById('entrada').getAttribute('aria-label'),
    selectSinEtiqueta: !document.querySelector('label[for=modo]') && !document.getElementById('modo').getAttribute('aria-label'),
    hiloSinLive: !document.getElementById('hilo').getAttribute('aria-live')
  }));

  // ---- sin creditos (402) ----
  const db = fake.getDb();
  const u = db.collection('users').docs[db.collection('users').docs.length-1];
  await db.collection('users').updateOne({_id:u._id},{$set:{creditBalance:0}});
  await pg.fill('#entrada','otra mas');
  await pg.press('#entrada','Enter');
  await pg.waitForTimeout(1800);
  out.sinCreditos = await pg.evaluate(() => ({
    panelAbierto: !!document.querySelector('#panel.abierto'),
    chipEnRojo: document.getElementById('chipSaldo').classList.contains('vacio'),
    saldo: document.getElementById('numSaldo').textContent.trim(),
    mensaje: (document.querySelector('.turno.ia:last-child .texto')||{}).textContent
  }));
  await pg.screenshot({ path: entorno.captura('aud2-sincreditos.png') });
  await pg.close();

  // ---- panel en movil ----
  const pm = await b.newPage({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true });
  await pm.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'networkidle' });
  await pm.click('.lp-nav button.btn-luna');
  await pm.fill('#nombreCrear','Kevin');
  await pm.fill('#correoCrear', `m-${Date.now()}@t.local`);
  await pm.fill('#claveCrear','ClaveLarga123');
  await pm.click('#btnCrear');
  await pm.waitForTimeout(1600);
  await pm.click('#chipSaldo');
  await pm.waitForTimeout(700);
  out.panelMovil = await pm.evaluate(() => {
    const p = document.getElementById('panel').getBoundingClientRect();
    return { anchoPanel: Math.round(p.width), anchoPantalla: window.innerWidth, tapaTodo: p.width >= window.innerWidth - 2 };
  });
  await pm.screenshot({ path: entorno.captura('aud2-panel-movil.png') });
  await pm.close();

  console.log(JSON.stringify(out,null,1));
  await b.close(); process.exit(0);
})();
