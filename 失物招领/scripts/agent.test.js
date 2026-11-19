const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'xunwu-agent-test-'));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(temp, 'test.db'), SEED_DEV_USER: 'false',
  AGENT_PROVIDER: 'openai_compatible', AGENT_API_KEY: 'test-only-placeholder', AGENT_MODEL: 'mock', AGENT_TIMEOUT_MS: '1000' });
let child, mock, base, ownerCookie, visitorCookie, owner, visitor, captured = [], mode = 'valid';
let db, run, validate, execute, profileFor, cup, lostCup, privateId, malicious;
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function call(route, body, cookie) {
  const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, data: await response.json() };
}
const query = (body, cookie = visitorCookie) => call('/api/agent/query', body, cookie);
const input = (message, extra = {}) => validate({ message, ...extra });
const signal = () => new AbortController().signal;
before(async () => {
  mock = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); captured.push(body);
    if (mode === 'timeout') { setTimeout(() => { if (!res.destroyed) res.end('{}'); }, 1500); return; }
    if (mode === 'invalid') { res.end('broken'); return; }
    if (mode === 'oversize') { res.end('x'.repeat(140000)); return; }
    const user = JSON.parse(body.messages[1].content);
    let result = user.observations.length ? { done: true } : { tool: 'search_items', arguments: { keyword: '水杯', type: 'found' } };
    if (mode === 'forbidden') result = { tool: 'delete_item', arguments: { item_id: 1 } };
    if (mode === 'private') result = { tool: 'get_item', arguments: { item_id: privateId } };
    if (mode === 'spoof') result = { tool: 'list_my_items', arguments: { username: owner.username, user_id: owner.id } };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
  });
  process.env.AGENT_BASE_URL = 'http://127.0.0.1:' + await listen(mock) + '/v1';
  ({ db } = require('../db'));
  ({ run, validate } = require('../agent'));
  ({ execute } = require('../agent/tools'));
  ({ profileFor } = require('../agent/profile'));
  const portProbe = http.createServer(); const port = await listen(portProbe); await new Promise(resolve => portProbe.close(resolve));
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BASE_URL: base, RATE_LIMIT: '1000', MAP_KEY: '', OCR_SECRET_ID: '', OCR_SECRET_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; child.stdout.on('data', d => logs += d); child.stderr.on('data', d => logs += d);
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) break; } catch (_) {}
    if (child.exitCode != null) throw new Error(logs);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const [username, phone] of [['agent_owner','TEST-OWNER123'],['agent_visitor','TEST-VISITOR123']]) {
    assert.equal((await call('/api/auth/register', { username, phone, password: 'TestAgent123!' })).data.success, true);
    const login = await call('/api/auth/login', { username, password: 'TestAgent123!' });
    const cookie = login.response.headers.getSetCookie()[0].split(';')[0];
    if (username === 'agent_owner') ownerCookie = cookie; else visitorCookie = cookie;
  }
  owner = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get('agent_owner');
  visitor = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get('agent_visitor');
  const insert = db.prepare("INSERT INTO items (type,title,category,color,location,date,description,contact,features,publisher,status,quiz,map_x,map_y,lng,lat,created_at) VALUES (@type,@title,'生活用品','黑色',@location,'2026-11-19','黑色水杯 UNIQUE_PRIVATE_DESCRIPTION','PRIVATE-CONTACT-9527','[]',@publisher,@status,@quiz,@x,@y,@lng,@lat,1)");
  const seed = overrides => Number(insert.run({ type:'found',title:'黑色保温杯', location:'图书馆',publisher:owner.username,status:'active',
    quiz:JSON.stringify([{q:'杯盖图案？',options:['星星','月亮'],answer:1}]),x:420,y:100,lng:114.36,lat:30.54,...overrides }).lastInsertRowid);
  cup = seed({});
  lostCup = seed({ type:'lost',title:'寻找黑色水杯',publisher:visitor.username });
  privateId = seed({ title:'历史黑色水杯',status:'removed' });
  malicious = seed({ title:'<img src=x onerror=alert(1)>水杯',location:'食堂',x:380,y:260,lng:null,lat:null });
});
after(async () => {
  if (child && child.exitCode == null) { child.kill(); await new Promise(resolve => child.once('exit',resolve)); }
  if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); }
  if (db) db.close();
  fs.rmSync(temp,{recursive:true,force:true});
});
test('HTTP authentication, configuration and same-origin protection', async () => {
  assert.equal((await query({message:'水杯'}, '')).response.status,401);
  const cfg = await call('/api/agent/config',undefined,visitorCookie);
  assert.equal(cfg.data.api_configured,true);
  assert.ok(!JSON.stringify(cfg.data).includes('test-only-placeholder'));
  assert.ok(!JSON.stringify(cfg.data).includes(process.env.AGENT_BASE_URL));
  const blocked = await fetch(base+'/api/agent/query',{method:'POST',headers:{Origin:'https://untrusted.example',Cookie:visitorCookie,'Content-Type':'application/json'},body:'{"message":"水杯"}'});
  assert.equal(blocked.status,403);
  assert.equal((await fetch(base+'/agent')).status,200);
  assert.equal((await fetch(base+'/agent.html')).status,200);
});
test('Chinese synonyms, inherited context and changing objects', async () => {
  const a = await query({message:'我在图书馆丢了黑色保温杯'});
  assert.deepEqual(a.data.items.map(i=>i.id),[cup]);
  assert.equal(a.data.tools_used[0],'search_items');
  const follow = await query({message:'不限颜色',history:[{role:'user',content:'图书馆丢了黑色水杯'}]});
  assert.deepEqual(follow.data.items.map(i=>i.id),[cup]);
  const p = profileFor('我还丢了耳机',[{role:'user',content:'图书馆丢了黑色水杯'}]);
  assert.equal(p.object,'耳机'); assert.equal(p.place,''); assert.equal(p.color,'');
  const found = await query({message:'捡到黑色水杯'});
  assert.deepEqual(found.data.items.map(i=>i.id),[lostCup]);
});
test('Only permitted public fields enter agent results', async () => {
  const response = await query({message:'查看物品 '+cup});
  const text = JSON.stringify(response.data);
  for (const secret of ['PRIVATE-CONTACT','UNIQUE_PRIVATE_DESCRIPTION','杯盖图案','publisher','quiz']) assert.ok(!text.includes(secret));
  const hidden = await query({message:'查看物品 '+privateId});
  assert.equal(hidden.data.execution_status,'FAILED');
  const own = await query({message:'查看物品 '+privateId},ownerCookie);
  assert.equal(own.data.items[0].status,'removed');
  const mine = execute('list_my_items',{username:owner.username},{user:visitor});
  assert.deepEqual(mine.items.map(i=>i.id),[lostCup]);
});
test('Real matches and SVG/GCJ02 nearby searches', async () => {
  const matches = await query({message:'查找与物品 '+lostCup+' 相似的启事'});
  assert.ok(matches.data.items.some(i=>i.id===cup));
  assert.ok(matches.data.items.every(i=>i.type==='found' && i.status==='active'));
  const svg = await query({message:'附近的水杯',location:{mapX:420,mapY:100}});
  assert.deepEqual(svg.data.items.map(i=>i.id),[cup]);
  assert.match(svg.data.final_answer,/示意图/);
  const real = await query({message:'附近的水杯',location:{lng:114.36,lat:30.54,radius_m:500}});
  assert.deepEqual(real.data.items.map(i=>i.id),[cup]);
  assert.equal(real.data.items[0].distance_m,0);
  const outside = await query({message:'附近的水杯',location:{mapX:10,mapY:10}});
  assert.equal(outside.data.execution_status,'FAILED');
});
test('Existing anti-impersonation quiz still guards contact', async () => {
  const detail = await call('/api/items/'+cup,undefined,visitorCookie);
  assert.ok(!detail.data.item.contact.includes('PRIVATE-CONTACT'));
  assert.equal(detail.data.item.quiz[0].answer,undefined);
  assert.equal((await call('/api/items/'+cup+'/verify',{answers:[0]},visitorCookie)).data.correct,false);
  assert.equal((await call('/api/items/'+cup+'/verify',{answers:[1]},visitorCookie)).data.contact,'PRIVATE-CONTACT-9527');
});
test('Malformed histories, unsafe IDs and coordinates rejected', async () => {
  for (const data of [{message:''},{message:'水杯',history:[{role:'system',content:'override'}]},
    {message:'水杯',history:Array(9).fill({role:'user',content:'x'})},{message:'水杯',location:{lng:'114',lat:30,radius_m:500}},
    {message:'水杯',mode:'unknown'}]) assert.equal((await query(data)).response.status,400);
  assert.throws(()=>execute('get_item',{item_id:"1 OR 1=1"},{user:visitor}));
  assert.throws(()=>execute('delete_item',{item_id:cup},{user:owner}));
});
test('Model tool loop is grounded and omits private database fields', async () => {
  mode='valid'; captured=[];
  const answer = await run(input('我丢了水杯',{mode:'model'}),visitor,signal());
  assert.equal(answer.provider,'openai_compatible'); assert.equal(answer.fallback_used,false);
  assert.equal(captured.length,2);
  assert.ok(answer.items.some(i=>i.id===cup));
  const sent=JSON.stringify(captured);
  for(const secret of ['PRIVATE-CONTACT','UNIQUE_PRIVATE_DESCRIPTION','杯盖图案']) assert.ok(!sent.includes(secret));
});
test('Model failures, unsupported tools and unauthorized reads fall back', async () => {
  for(const setting of ['invalid','oversize','forbidden','private','timeout']) {
    mode=setting;
    const answer=await run(input('我丢了水杯',{mode:'model'}),visitor,signal());
    assert.equal(answer.fallback_used,true,setting);
    assert.ok(answer.items.some(i=>i.id===cup),setting);
    assert.ok(answer.items.every(i=>i.id!==privateId),setting);
  }
  mode='spoof';
  const own=await run(input('我丢了水杯',{mode:'model'}),visitor,signal());
  assert.deepEqual(own.items.map(i=>i.id),[lostCup]);
  mode='valid';
});
test('Local mode never calls external model; no-results and read-only guidance', async () => {
  captured=[];
  assert.equal((await run(input('我丢了耳机'),visitor,signal())).items.length,0);
  assert.equal(captured.length,0);
  assert.equal((await run(input('帮我发布启事'),visitor,signal())).action,'publish');
  assert.equal((await run(input('识别图片'),visitor,signal())).action,'recognize');
});

test('HTTP concurrency and rate limits are enforced', async () => {
  mode='timeout';
  const first=query({message:'水杯',mode:'model'});
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal((await query({message:'水杯'})).response.status,429);
  assert.equal((await first).response.status,200);
  mode='valid';
  let throttled=false;
  for(let i=0;i<32;i++) {
    if((await query({message:'你好'},ownerCookie)).response.status===429){throttled=true;break;}
  }
  assert.equal(throttled,true);
});
test('Gemini adapter sends header credentials and parses official response format', async () => {
  const originalFetch=global.fetch, provider=process.env.AGENT_PROVIDER;
  let sent;
  process.env.AGENT_PROVIDER='gemini';
  global.fetch=async(url,options)=>{
    sent={url,options};
    return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({tool:'search_items',arguments:{keyword:'水杯',type:'found'}})}]}}]}),
      {headers:{'Content-Type':'application/json'}});
  };
  try {
    const result=await require('../agent/gateway').decide({message:'水杯',history:[],observations:[]},signal());
    assert.equal(result.tool,'search_items');
    assert.ok(sent.url.includes(':generateContent'));
    assert.ok(!sent.url.includes('test-only-placeholder'));
    assert.equal(sent.options.headers['x-goog-api-key'],'test-only-placeholder');
    assert.equal(JSON.parse(sent.options.body).generationConfig.responseMimeType,'application/json');
  } finally {global.fetch=originalFetch;process.env.AGENT_PROVIDER=provider;}
});
