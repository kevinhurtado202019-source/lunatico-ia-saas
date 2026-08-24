const { chromium } = require('playwright');
const entorno = require('./entorno');
const fake = require('./fake-mongo');
require.cache[require.resolve('mongodb')] = { id:'m',filename:'m',loaded:true,exports:fake,paths:[] };
let romper = false;
function A(){ this.messages={ create: async p => {
  if (romper) { const e = new Error('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"},"request_id":"req_011SECRETO"}'); throw e; }
  return { content:[{type:'text',text:'Respuesta de prueba.'}], usage:{input_tokens:1600,output_tokens:400}, model:p.model };
} }; }
A.default=A;
require.cache[require.resolve('@anthropic-ai/sdk')] = { id:'a',filename:'a',loaded:true,exports:A,paths:[] };
const PORT=4915;
Object.assign(process.env,{MONGODB_URI:'mongodb://f/l',JWT_SECRET:'s',CLAUDE_API_KEY:'k',
  WOMPI_PUBLIC_KEY:'p',WOMPI_INTEGRITY_SECRET:'i',WOMPI_EVENTS_SECRET:'e',PORT:String(PORT)});
require('../server-saas.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

(async () => {
  for(let i=0;i<60;i++){ try{ if((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) break; }catch(e){} await sleep(200); }
  const b = await chromium.launch(entorno.opcionesNavegador());
  const R=[]; const ok=(n,c,d)=>R.push({n,ok:!!c,d});
  const paso=async(n,f)=>{ try{ ok(n,true,await f()); }catch(e){ ok(n,false,String(e.message||e).split('\n')[0].slice(0,130)); } };

  const ctx = await b.newContext({ viewport:{width:1200,height:820} });
  const pg = await ctx.newPage();
  await pg.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'networkidle' });
  const email = `t-${Date.now()}@t.local`;
  await pg.click('.lp-nav button.btn-luna');
  await pg.fill('#nombreCrear','Kevin'); await pg.fill('#correoCrear',email); await pg.fill('#claveCrear','ClaveLarga123');
  await pg.click('#btnCrear'); await pg.waitForTimeout(1600);

  // ---- ERRORES QUE VE EL CLIENTE ----
  await paso('El fallo de la API no filtra detalles internos', async () => {
    romper = true;
    await pg.fill('#entrada','provoca el fallo');
    await pg.press('#entrada','Enter');
    await pg.waitForTimeout(2000);
    romper = false;
    const t = await pg.evaluate(() => document.body.innerText);
    if (/request_id|x-api-key|authentication_error|401 \{/.test(t)) throw new Error('filtra: ' + t.match(/.{0,60}(request_id|x-api-key).{0,30}/)[0]);
    if (!/No pudimos generar la respuesta/.test(t)) throw new Error('no muestra el mensaje limpio');
    return 'mensaje limpio, sin internos';
  });

  await paso('Y aclara que no se cobro', async () => {
    const t = await pg.evaluate(() => document.body.innerText);
    if (!/no se te descontó/i.test(t)) throw new Error('no lo dice');
    return 'lo dice';
  });

  // ---- DOS PESTANAS ----
  await paso('Comprar en otra pestana se refleja al volver', async () => {
    const saldoAntes = (await pg.textContent('#numSaldo')).trim();
    const p2 = await ctx.newPage();
    await p2.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'networkidle' });
    await p2.waitForTimeout(800);
    // simular abono desde fuera (como haria el webhook)
    const db = fake.getDb();
    const u = db.collection('users').docs.filter(d => d.email === email)[0];
    await db.collection('users').updateOne({_id:u._id},{$inc:{creditBalance:3000}});
    await p2.close();
    await pg.bringToFront();
    await pg.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await pg.waitForTimeout(1200);
    const saldoDespues = (await pg.textContent('#numSaldo')).trim();
    if (saldoAntes === saldoDespues) throw new Error('sigue en ' + saldoDespues);
    return saldoAntes + ' -> ' + saldoDespues;
  });

  await paso('Cerrar sesion en otra pestana cierra esta', async () => {
    const p3 = await ctx.newPage();
    await p3.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'networkidle' });
    await p3.waitForTimeout(900);
    await p3.evaluate(() => localStorage.removeItem('authToken'));
    await p3.close();
    // el evento storage llega a las demas pestanas del mismo contexto
    await pg.waitForTimeout(2200);
    const enLanding = await pg.isVisible('#landing');
    if (!enLanding) throw new Error('la otra pestana sigue dentro');
    return 'la sesion se cerro en las dos';
  });
  await pg.close();

  // ---- ALTO EN MOVIL ----
  await paso('El alto usa dvh, que si encoge con el teclado', async () => {
    const pm = await b.newPage({ viewport:{width:390,height:844}, hasTouch:true, isMobile:true });
    await pm.goto(`http://127.0.0.1:${PORT}/`, { waitUntil:'networkidle' });
    const v = await pm.evaluate(() => {
      const hojas = [...document.styleSheets].filter(s => !s.href);
      let txt = '';
      hojas.forEach(s => { try { [...s.cssRules].forEach(r => txt += r.cssText); } catch(e){} });
      return /100dvh/.test(txt);
    });
    await pm.close();
    if (!v) throw new Error('no se aplica dvh');
    return 'dvh aplicado';
  });

  const pass=R.filter(r=>r.ok).length;
  console.log('\n===================================================');
  console.log(`  ERRORES, PESTANAS Y MOVIL: ${pass}/${R.length}`);
  console.log('===================================================');
  for(const r of R) console.log(`${r.ok?'  OK    ':'  FALLA '} ${r.n}${r.d?'   ['+r.d+']':''}`);
  console.log('');
  await b.close(); process.exit(0);
})();
