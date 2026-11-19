#!/usr/bin/env node
// Real Chrome smoke test. Isolated SQLite DB, accounts and browser profile; no npm browser dependency.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xunwu-browser-'));
const chromePath = process.env.CHROME_PATH || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const delay = ms => new Promise(resolve => setTimeout(resolve,ms));
let service, chrome, ws, seq=0;
const pending = new Map(), errors = [];
async function waitFor(check, label, timeout=15000) {
  const end=Date.now()+timeout;
  while(Date.now()<end) { if(await check()) return; await delay(100); }
  throw new Error('Timeout: '+label);
}
function cdp(method,params={}) {
  return new Promise((resolve,reject) => {
    const id=++seq;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
    pending.set(id,{resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(error);}});
    ws.send(JSON.stringify({id,method,params}));
  });
}
async function evaluate(expression) {
  const result=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function main() {
  if(!fs.existsSync(chromePath)) throw new Error('Set CHROME_PATH to an installed Chrome executable.');
  const probe=http.createServer(); await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  const port=probe.address().port; await new Promise(resolve=>probe.close(resolve));
  const base='http://127.0.0.1:'+port;
  service=spawn(process.execPath,['server.js'],{cwd:root,windowsHide:true,stdio:'ignore',env:{...process.env,
    NODE_ENV:'test',PORT:String(port),HOST:'127.0.0.1',BASE_URL:base,DB_PATH:path.join(temp,'browser.db'),
    SEED_DEV_USER:'false',AGENT_PROVIDER:'heuristic',AGENT_BASE_URL:'',AGENT_TIMEOUT_MS:'12000',MAP_KEY:'',OCR_SECRET_ID:'',OCR_SECRET_KEY:'',RATE_LIMIT:'1000'}});
  await waitFor(async()=>{try{return (await fetch(base+'/health')).ok;}catch(_){return false;}},'server');
  const request=async(route,body,cookie)=>{
    const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
    return {response,data:await response.json()};
  };
  for(const name of ['browser_owner','browser_visitor']) assert.equal((await request('/api/auth/register',{username:name,password:'BrowserTest123!',phone:'TEST-'+name.replace('browser_','').toUpperCase()+'1234'})).data.success,true);
  const login=await request('/api/auth/login',{username:'browser_owner',password:'BrowserTest123!'});
  const cookie=login.response.headers.getSetCookie()[0].split(';')[0];
  const item={type:'found',title:'图书馆捡到黑色保温杯',category:'生活用品',color:'黑色',location:'图书馆',date:'2026-11-19',
    description:'浏览器验收测试数据：黑色保温杯，杯盖上有图案。',contact:'BROWSER-TEST-CONTACT',features:['水杯'],mapX:420,mapY:100,
    quiz:[{q:'杯盖上是什么图案？',options:['星星','月亮'],answer:1}]};
  assert.equal((await request('/api/items',item,cookie)).response.status,201);
  assert.equal((await request('/api/items',{...item,title:'<img src=x onerror=alert(1)>水杯',location:'食堂'},cookie)).response.status,201);
  chrome=spawn(chromePath,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--remote-debugging-port=0','--user-data-dir='+path.join(temp,'chrome'),'about:blank'],{windowsHide:true,stdio:'ignore'});
  const portFile=path.join(temp,'chrome','DevToolsActivePort');
  await waitFor(()=>fs.existsSync(portFile),'Chrome');
  const debugPort=fs.readFileSync(portFile,'utf8').split('\n')[0];
  const pages=await (await fetch('http://127.0.0.1:'+debugPort+'/json/list')).json();
  ws=new WebSocket(pages.find(p=>p.type==='page').webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve);ws.addEventListener('error',reject);});
  ws.addEventListener('message',event=>{
    const data=JSON.parse(event.data);
    if(data.id) { const entry=pending.get(data.id); if(entry){pending.delete(data.id);data.error?entry.reject(new Error(JSON.stringify(data.error))):entry.resolve(data.result);} }
    else if(data.method==='Runtime.exceptionThrown') errors.push(data.params.exceptionDetails.text);
    else if(data.method==='Page.javascriptDialogOpening') {errors.push('Unexpected JS dialog');cdp('Page.handleJavaScriptDialog',{accept:false}).catch(()=>{});}
  });
  await cdp('Page.enable'); await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
  await cdp('Page.navigate',{url:base+'/login.html'});
  await waitFor(()=>evaluate("document.readyState === 'complete'"),'login page');
  assert.equal(await evaluate("fetch(apiUrl('/api/auth/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'browser_visitor',password:'BrowserTest123!'})}).then(r=>r.json()).then(d=>d.success)"),true);
  await cdp('Page.navigate',{url:base+'/agent.html'});
  await waitFor(()=>evaluate("!!document.querySelector('.bubble') && !!document.querySelector('#agentMap svg')"),'agent init');
  assert.equal(await evaluate("document.querySelector('#navUsername').textContent"),'browser_visitor');
  const send=async(text)=>{
    await evaluate("document.querySelector('#message').value="+JSON.stringify(text)+";document.querySelector('#chatForm').requestSubmit()");
    await waitFor(()=>evaluate("!document.querySelector('#sendMessage').disabled"),'query complete');
  };
  await send('我在图书馆丢了黑色保温杯');
  assert.equal(await evaluate("document.querySelectorAll('.result-card').length"),1);
  assert.ok(await evaluate("document.querySelector('.result-card').textContent.includes('图书馆')"));
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true);
  const output=process.env.AGENT_SCREENSHOTS;
  if(output) {
    fs.mkdirSync(output,{recursive:true});
    const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(output,'agent-desktop.png'),Buffer.from(shot.data,'base64'));
  }
  await evaluate("document.querySelector('.result-card button').click()");
  await waitFor(()=>evaluate("!!document.querySelector('#detailBody form')"),'detail quiz');
  assert.equal(await evaluate("document.querySelector('#detailBody').textContent.includes('BROWSER-TEST-CONTACT')"),false);
  await evaluate("document.querySelector('#detailBody input[value=\"0\"]').click();document.querySelector('#detailBody form').requestSubmit()");
  await waitFor(()=>evaluate("document.querySelector('#detailBody [role=status]').textContent.includes('不完全正确')"),'wrong answer');
  await evaluate("document.querySelector('#detailBody input[value=\"1\"]').click();document.querySelector('#detailBody form').requestSubmit()");
  await waitFor(()=>evaluate("document.querySelector('#detailBody .contact').textContent.includes('BROWSER-TEST-CONTACT')"),'contact unlock');
  await evaluate("document.querySelector('#closeDetail').click();document.querySelector('#resetChat').click()");
  // SVG click at actual transformed coordinates (not a synthetic onPick invocation).
  await evaluate("(function(){const svg=document.querySelector('#agentMap svg');const p=svg.createSVGPoint();p.x=420;p.y=100;const c=p.matrixTransform(svg.getScreenCTM());svg.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:c.x,clientY:c.y}));})()");
  assert.equal(await evaluate("document.querySelector('#nearbySearch').disabled"),false);
  await evaluate("document.querySelector('#nearbySearch').click()");
  await waitFor(()=>evaluate("!document.querySelector('#sendMessage').disabled"),'nearby results');
  assert.ok(await evaluate("document.querySelector('#messages').textContent.includes('示意图')"));
  await evaluate("document.querySelector('#resetChat').click()");
  await send('我丢了水杯');
  assert.ok(await evaluate("document.querySelector('#messages').textContent.includes('<img src=x')"));
  assert.equal(await evaluate("document.querySelectorAll('.result-card img').length"),0);
  await cdp('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  await delay(300);
  assert.equal(await evaluate("document.documentElement.scrollWidth <= innerWidth"),true);
  if(output) {
    await evaluate("document.querySelector('#resetChat').click()");
    await send('我在图书馆丢了黑色保温杯');
    const shot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(output,'agent-mobile.png'),Buffer.from(shot.data,'base64'));
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: desktop/mobile, login, real search, quiz unlock, SVG nearby, reset, text-safe rendering; no runtime errors.');
  const e2e=spawn(process.execPath,['scripts/check-e2e-flow.js',base],{cwd:root,windowsHide:true,stdio:'inherit'});
  const status=await new Promise(resolve=>e2e.once('exit',resolve));
  assert.equal(status,0,'existing project E2E flow');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(ws?.readyState===WebSocket.OPEN) {try{await cdp('Browser.close');}catch(_){} ws.close();}
  for(const processChild of [chrome,service]) {
    if(processChild && processChild.exitCode==null) {processChild.kill();await Promise.race([new Promise(resolve=>processChild.once('exit',resolve)),delay(3000)]);}
  }
  await delay(300);
  fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:300});
});
