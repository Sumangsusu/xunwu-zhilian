const { profileFor, localPlan } = require('./profile');
const { execute, catalog } = require('./tools');
const gateway = require('./gateway');
const activeUsers = new Set();
function validate(body) {
  if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) throw new Error('消息应为 1–2000 个字符。');
  const history = body.history || [];
  if (!Array.isArray(history) || history.length > 8 || history.some(t => !t || !['user','assistant'].includes(t.role) ||
    typeof t.content !== 'string' || t.content.length > 2000)) throw new Error('对话历史格式不正确。');
  const mode = body.mode || 'local';
  if (!['local', 'model'].includes(mode)) throw new Error('助手模式无效。');
  let location = null;
  const number = (v, low, high) => typeof v === 'number' && Number.isFinite(v) && v >= low && v <= high;
  if (body.location != null) {
    const p = body.location;
    if (number(p.lng, 0, 180) && number(p.lat, 0, 90) && number(p.radius_m, 100, 5000)) {
      location = { lng: p.lng, lat: p.lat, radius_m: p.radius_m };
    } else if (p.lng == null && p.lat == null && number(p.mapX, 0, 1000) && number(p.mapY, 0, 700)) {
      location = { mapX: p.mapX, mapY: p.mapY };
    } else throw new Error('请选择有效的地图位置和搜索范围。');
  }
  return { message: body.message.trim(), history: history.map(t => ({ role: t.role, content: t.content })), mode, location };
}
async function run(input, user, signal) {
  const profile = profileFor(input.message, input.history);
  const plan = localPlan(input.message, profile);
  const nearby = /附近/.test(input.message);
  const result = { final_answer: '', items: [], map_items: [], tools_used: [], steps_count: 0,
    execution_status: 'COMPLETED', provider: 'local', fallback_used: false, follow_up_questions: [], location_insight: [] };
  if (plan.answer) return { ...result, final_answer: plan.answer, action: plan.action };
  if (nearby && !input.location) return { ...result, final_answer: '请先在地图选择搜索位置，再发送“附近的物品”；也可以直接告诉我地点名称。' };
  let model = input.mode === 'model' && gateway.connection().configured;
  if (input.mode === 'model' && !model) result.fallback_used = true;
  const observations = [], seen = new Set();
  for (let step = 0; step < 3; step++) {
    signal.throwIfAborted();
    let selection = plan;
    if (model) {
      try {
        selection = await gateway.decide({ message: input.message, history: input.history, confirmed: profile, observations }, signal);
        result.provider = gateway.connection().provider;
        if (selection.done && observations.length) break;
        if (selection.done) throw new Error('模型未检索');
      } catch (_) { model = false; result.fallback_used = true; selection = plan; }
    }
    if (plan.tool !== 'search_items' || nearby) selection = plan;
    const key = JSON.stringify(selection);
    if (seen.has(key)) break;
    seen.add(key);
    try {
      const output = execute(selection.tool, selection.arguments, { user, profile, nearby, location: input.location });
      observations.push({ tool: selection.tool, result: output });
      result.tools_used.push(selection.tool);
      result.steps_count++;
    } catch (error) {
      if (model) { model = false; result.fallback_used = true; seen.delete(JSON.stringify(plan)); continue; }
      return { ...result, execution_status: 'FAILED', final_answer: error.message };
    }
    if (!model || plan.tool !== 'search_items' || nearby) break;
  }
  signal.throwIfAborted();
  const last = observations.at(-1);
  if (!last) return { ...result, execution_status: 'FAILED', final_answer: '暂时未能完成检索，请稍后重试。' };
  const output = last.result;
  result.items = output.items;
  result.map_items = output.items;
  result.location_insight = output.hotspots || [];
  result.tools_used = [...new Set(result.tools_used)];
  result.follow_up_questions = last.tool === 'search_items' ? profile.questions : [];
  result.final_answer = output.total ? '找到 ' + output.total + ' 条相关启事' + (output.total > output.items.length ? '，先展示最相关的 ' + output.items.length + ' 条' : '') +
    '。请打开详情核对物品；相似线索不代表已确认归属。' : '暂时没有符合条件的启事。可以更换地点、输入“不限颜色”，或发布启事留下线索。';
  if (output.notice) result.final_answer += '\n' + output.notice;
  if (result.fallback_used) result.final_answer += '\n模型服务未完成本次查询，已使用站内检索。';
  return result;
}
function mount(app, authRequired, rateLimit) {
  gateway.connection();
  app.get('/api/agent/config', authRequired, (_req, res) => res.json({ success: true, ...gateway.publicConfig(), tools: catalog.map(t => t.name) }));
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, keyGenerator: req => String(req.user.id),
    standardHeaders: 'draft-8', legacyHeaders: false, message: { success: false, message: '助手请求过于频繁，请稍后再试。' } });
  app.post('/api/agent/query', authRequired, limiter, async (req, res, next) => {
    let input;
    try { input = validate(req.body); } catch (e) { return res.status(400).json({ success: false, message: e.message }); }
    const userId = req.user.id;
    if (activeUsers.has(userId) || activeUsers.size >= 8) return res.status(429).json({ success: false, message: '助手正在处理请求，请稍后再试。' });
    activeUsers.add(userId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    const close = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', close);
    try { res.json({ success: true, ...await run(input, req.user, controller.signal) }); }
    catch (e) {
      if (controller.signal.aborted) { if (!res.destroyed) res.status(504).json({ success: false, message: '查询超时，请重试。' }); }
      else next(e);
    } finally { clearTimeout(timer); res.off('close', close); activeUsers.delete(userId); }
  });
}
module.exports = { mount, validate, run };
