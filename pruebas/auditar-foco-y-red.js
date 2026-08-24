const { chromium } = require('playwright');
const entorno = require('./entorno');
const fake = require('./fake-mongo');
require.cache[require.resolve('mongodb')] = { id:'m',filename:'m',loaded:true,exports:fake,paths:[] };
let lentitud = 0;
function A(){ this.messages={ create: async p => {
  if (lentitud) await new Promise(r=>setTimeout(r,lentitud));
  return { content:[{type:'text',text:'Respuesta de prueba.'}], usage:{input_tokens:1600,output_tokens:400}, model:p.model };
} }; }
A.default=A;
require.cache[require.resolve('@anthropic-ai/sdk')] = { id:'a',filename:'a',loaded:true,exports:A,paths:[] };
const PORT=4913;
Object.assign(process.env,{MONGODB_URI:'mongodb://f/l',JWT_SECRET:'s',CLAUDE_API_KEY:'k',
  WOMPI_PUBLIC_KEY:'p',WOMPI_INTEGRITY_SECRET:'i',WOMPI_EVENTS_SECRET:'e',PORT:String(PORT)});
require('../server-saas.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async () => {
  for(let i=0;i<60;i++){ try{ if((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; }catch(e){} await sleep(200); }
  const b = await chromium.launch(entorno.opcionesNavegador());
  const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d});
  const paso=async(n,f)=>{ try{ ok(n,true,await f()); }catch(e){ ok(n,false,String(e.message||e).split('\n')[0].slice(0,120)); } };

  const pg = await b.newPage({ viewport:{width:1280,height:860} });
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'networkidle' });
  await pg.click('.lp-nav button.btn-luna');
  await pg.fill('#nombreCrear','Kevin');
  await pg.fill('#correoCrear', `f-${Date.now()}@t.local`);
  await pg.fill('#claveCrear','ClaveLarga123');
  await pg.click('#btnCrear');
  await pg.waitForTimeout(1600);

  // ---------- FOCO Y TECLADO ----------
  await paso('Al abrir el panel, el foco entra en el', async () => {
    await pg.click('#chipSaldo');
    await pg.waitForTimeout(500);
    const dentro = await pg.evaluate(() => document.getElementById('panel').contains(document.activeElement));
    if (!dentro) throw new Error('el foco sigue fuera: ' + await pg.evaluate(()=>document.activeElement.className||document.activeElement.tagName));
    return 'ok';
  });

  await paso('Tabulando no se sale del panel al fondo', async () => {
    let fuera = 0;
    for (let i=0;i<14;i++){
      await pg.keyboard.press('Tab');
      const f = await pg.evaluate(() => {
        const a = document.activeElement;
        const p = document.getElementById('panel');
        return { dentro: p.contains(a), q: (a.className||a.tagName).toString().slice(0,28) };
      });
      if (!f.dentro) fuera++;
    }
    if (fuera) throw new Error(fuera + ' de 14 tabulaciones cayeron fuera del panel');
    return 'las 14 se quedan dentro';
  });

  await paso('Al cerrar el panel, el foco vuelve al boton que lo abrio', async () => {
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(400);
    const id = await pg.evaluate(() => document.activeElement.id || document.activeElement.className);
    if (!/chipSaldo/.test(id)) throw new Error('el foco quedo en: ' + id);
    return 'vuelve al chip';
  });

  await paso('El fondo se marca inerte para lectores de pantalla', async () => {
    await pg.click('#chipSaldo');
    await pg.waitForTimeout(400);
    const v = await pg.evaluate(() => document.getElementById('app').getAttribute('aria-hidden'));
    await pg.keyboard.press('Escape');
    await pg.waitForTimeout(300);
    if (v !== 'true') throw new Error('aria-hidden del fondo = ' + v);
    return 'ok';
  });

  // ---------- RED CAIDA ----------
  await paso('Si se cae la red, el mensaje no se pierde', async () => {
    await pg.route('**/api/chat', r => r.abort('failed'));
    await pg.fill('#entrada', 'mensaje que no va a llegar');
    await pg.press('#entrada','Enter');
    await pg.waitForTimeout(1600);
    const txt = await pg.evaluate(() => document.body.innerText);
    const recuperable = await pg.inputValue('#entrada');
    await pg.unroute('**/api/chat');
    if (!/no se pudo|sin conexión|error/i.test(txt)) throw new Error('no avisa del fallo');
    if (!recuperable) throw new Error('el texto se perdio y hay que reescribirlo');
    return 'avisa y devuelve el texto al campo';
  });

  await paso('Tras el fallo se puede reintentar', async () => {
    await pg.fill('#entrada','ahora si');
    await pg.press('#entrada','Enter');
    await pg.waitForTimeout(1800);
    const t = await pg.$$eval('.turno.ia .texto', e=>e.map(x=>x.textContent));
    if (!t.some(x=>x.includes('Respuesta de prueba'))) throw new Error('no respondio');
    return 'ok';
  });

  // ---------- DOBLE ENVIO ----------
  await paso('Pulsar Enter dos veces no manda el mensaje dos veces', async () => {
    lentitud = 1200;
    const antes = await pg.$$eval('.turno.yo', e=>e.length);
    await pg.fill('#entrada','mensaje unico');
    await pg.press('#entrada','Enter');
    await pg.waitForTimeout(60);
    await pg.press('#entrada','Enter');
    await pg.press('#entrada','Enter');
    await pg.waitForTimeout(2600);
    lentitud = 0;
    const despues = await pg.$$eval('.turno.yo', e=>e.length);
    if (despues - antes !== 1) throw new Error('se enviaron ' + (despues-antes));
    return 'solo uno';
  });

  await paso('Mientras responde, el boton de enviar esta bloqueado', async () => {
    lentitud = 1400;
    await pg.fill('#entrada','otro mas');
    await pg.press('#entrada','Enter');
    await pg.waitForTimeout(400);
    const dis = await pg.evaluate(() => document.getElementById('btnEnviar').disabled);
    await pg.waitForTimeout(2200);
    lentitud = 0;
    if (!dis) throw new Error('el boton seguia activo');
    return 'ok';
  });

  const pass=R.filter(r=>r.ok).length;
  console.log('\n=================================================');
  console.log(`  FOCO, RED Y CONCURRENCIA: ${pass}/${R.length}`);
  console.log('=================================================');
  for(const r of R) console.log(`${r.ok?'  OK    ':'  FALLA '} ${r.n}${r.d?'   ['+r.d+']':''}`);
  console.log('');
  await b.close(); process.exit(0);
})();
