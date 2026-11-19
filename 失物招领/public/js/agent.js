/* UniFound capabilities adapted to the site's authenticated API and campus map. */
(async function () {
  'use strict';
  const el = id => document.getElementById(id);
  if (!await requireAuth()) return;
  const history = [];
  let busy = false, controller = null, selected = null, mapHandle = null, detailVersion = 0;
  const make = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text != null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  function bubble(role, text) {
    const node = make('div', null, 'bubble ' + role);
    node.append(make('span', role === 'user' ? '你' : '寻物助手', 'speaker'), make('p', text));
    el('messages').append(node);
    el('messages').scrollTop = el('messages').scrollHeight;
    return node;
  }
  function welcome() { bubble('assistant', '你好！告诉我你丢了什么，或捡到了什么。\n我会查找站内真实启事，也可以按编号查询状态、寻找相似线索。'); }
  function setBusy(value) {
    busy = value;
    el('sendMessage').disabled = value;
    el('message').disabled = value;
    el('agentMode').disabled = value;
    el('nearbySearch').disabled = value || !selected;
    el('chatForm').setAttribute('aria-busy', String(value));
  }
  function fill(text) { if (!busy) { el('message').value = text; el('message').focus(); } }
  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => fill(button.dataset.prompt)));
  el('resetChat').addEventListener('click', () => {
    if (controller) controller.abort();
    controller = null; history.length = 0;
    el('messages').replaceChildren(); el('followUps').replaceChildren();
    el('message').value = ''; el('requestState').textContent = '';
    clearLocation(); setBusy(false); welcome(); el('message').focus();
  });
  function clearLocation() {
    selected = null;
    mapHandle?.marker?.setGeometries?.([]);
    el('selectedLocation').textContent = '点击地图选点，也可以直接输入地点。';
    el('nearbySearch').disabled = true;
    const overlay = el('agentMap').querySelector('#mapOverlay');
    if (overlay) overlay.replaceChildren();
  }
  el('clearLocation').addEventListener('click', clearLocation);
  el('nearbySearch').addEventListener('click', () => { fill('查找附近的物品'); el('chatForm').requestSubmit(); });
  el('agentMode').addEventListener('change', () => {
    const model = el('agentMode').value === 'model';
    el('modeBadge').textContent = model ? '模型辅助' : '站内检索';
    el('modelNote').textContent = model ? '发送后，本轮消息、最近 8 条对话和检索字段将发送给站点配置的模型服务。请勿输入个人敏感信息。' :
      '使用网站现有数据检索。对话仅保留在当前页面，刷新后清空。';
  });
  try {
    const config = await api.get('/api/agent/config');
    if (config.api_configured) {
      const option = el('agentMode').querySelector('[value="model"]');
      option.disabled = false; option.textContent = '模型辅助 · ' + config.model;
    }
  } catch (error) { el('requestState').textContent = error.message; }
  if (window.CampusMapGL) {
    window.CampusMapGL.mount(el('agentMap'), {
      pick: true,
      currentLocation: () => selected?.address || '',
      onPick: point => {
        selected = point;
        el('selectedLocation').textContent = '已选择：' + (point.address || (point.lng != null ? '地图选点' : '校园区域'));
        el('nearbySearch').disabled = busy;
        if (mapHandle?.mode === 'svg') {
          const overlay = el('agentMap').querySelector('#mapOverlay');
          if (overlay) {
            overlay.replaceChildren();
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('cx', point.mapX); dot.setAttribute('cy', point.mapY);
            dot.setAttribute('r', '10'); dot.setAttribute('fill', '#f28a2e'); dot.setAttribute('stroke', '#20304f');
            overlay.append(dot);
          }
        }
      },
      onMode: handle => {
        mapHandle = handle;
        el('agentMap').style.height = handle.mode === 'gl' ? '460px' : '300px';
        el('mapMode').textContent = handle.mode === 'gl' ? '真实地图 · GCJ-02 坐标，点击选点。' : '校园示意图 · 点击建筑，按同一区域查找。';
        el('radiusLabel').hidden = handle.mode !== 'gl';
        // A fallback changes coordinate semantics; old picks must be selected again.
        if (selected && (handle.mode === 'gl') !== (selected.lng != null)) clearLocation();
      }
    });
  }
  function cards(parent, items) {
    const list = make('div', null, 'result-list');
    items.forEach(item => {
      const card = make('article', null, 'result-card');
      card.append(make('span', (item.type === 'found' ? '招领' : '寻物') + ' · #' + item.id, 'tag'), make('h3', item.title));
      const status = { active: '在架', resolved: '已结案', removed: '已撤销' }[item.status] || item.status;
      card.append(make('p', item.location + ' · ' + item.date + ' · ' + status));
      if (item.similarity != null) card.append(make('p', '匹配评分 ' + item.similarity + '/100 · ' + item.evidence.join('、')));
      if (item.distance_m != null) card.append(make('p', '约 ' + item.distance_m + ' 米（直线距离）'));
      const button = make('button', '查看详情与认领线索 →');
      button.type = 'button'; button.addEventListener('click', () => showDetail(item.id));
      card.append(button); list.append(card);
    });
    parent.append(list);
  }
  el('message').addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault(); if (!busy) el('chatForm').requestSubmit();
    }
  });
  el('chatForm').addEventListener('submit', async event => {
    event.preventDefault();
    const message = el('message').value.trim();
    if (busy || !message) return;
    setBusy(true); el('requestState').textContent = '正在查询站内启事…';
    const pending = bubble('user', message);
    el('followUps').replaceChildren();
    const request = new AbortController(); controller = request;
    const timeout = setTimeout(() => request.abort(), 40000);
    try {
      const location = !selected ? null : selected.lng != null ?
        { lng: selected.lng, lat: selected.lat, radius_m: Number(el('radius').value) } : { mapX: selected.mapX, mapY: selected.mapY };
      const response = await fetch(apiUrl('/api/agent/query'), { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, history: history.slice(-8), mode: el('agentMode').value, location }),
        signal: request.signal });
      const data = await response.json();
      if (!response.ok || !data.success) throw new Error(data.message || '查询失败，请稍后重试。');
      if (controller !== request) return;
      const answer = bubble('assistant', data.final_answer);
      cards(answer, data.items || []);
      if (data.action) {
        const link = make('a', data.action === 'recognize' ? '打开智能识别 →' : '打开发布启事 →');
        link.href = data.action === 'recognize' ? 'recognize.html' : 'publish.html'; answer.append(link);
      }
      (data.follow_up_questions || []).forEach(question => {
        const button = make('button', '补充：' + question.label);
        button.type = 'button'; button.addEventListener('click', () => fill(question.label + '：'));
        el('followUps').append(button);
      });
      history.push({ role: 'user', content: message }, { role: 'assistant', content: data.final_answer.slice(0, 2000) });
      history.splice(0, Math.max(0, history.length - 8));
      el('message').value = '';
      el('requestState').textContent = data.execution_status === 'FAILED' ? '未完成查询，可调整线索后重试。' :
        data.tools_used.length ? '已查询站内数据 · ' + data.steps_count + ' 次工具调用' : '可继续补充线索';
      el('messages').scrollTop = el('messages').scrollHeight;
    } catch (error) {
      if (controller !== request) return;
      pending.remove();
      el('requestState').textContent = request.signal.aborted ? '请求已超时，线索已保留，请重试。' : error.message;
    } finally {
      clearTimeout(timeout);
      if (controller === request) { controller = null; setBusy(false); el('message').focus(); }
    }
  });
  el('closeDetail').addEventListener('click', () => { detailVersion++; el('itemDialog').close(); });
  async function showDetail(id) {
    const version = ++detailVersion;
    const body = el('detailBody');
    el('detailTitle').textContent = '启事详情';
    body.replaceChildren(make('p', '正在加载…')); el('itemDialog').showModal();
    try {
      const item = await DB.getById(id);
      if (version !== detailVersion) return;
      el('detailTitle').textContent = item.title;
      body.replaceChildren(make('p', '#' + item.id + ' · ' + item.location + ' · ' + item.date), make('p', item.description));
      if (typeof item.image === 'string' && (/^\/?(?:images|uploads)\//.test(item.image) || /^data:image\/(?:png|jpeg|webp);base64,/.test(item.image))) {
        const img = make('img'); img.src = apiUrl(item.image); img.alt = '物品照片'; body.prepend(img);
      }
      const contact = make('p', '联系方式：' + (item.contact || '暂无'), 'contact'); body.append(contact);
      const user = UserDB.getCurrent();
      if (item.status === 'active' && item.publisher !== user.username && user.role !== 'admin') {
        const form = make('form');
        form.append(make('p', item.hasQuiz ? '完成防冒领问答后查看联系方式。' : '此启事未设置问答，可点击下方按钮查看联系方式。'));
        (item.quiz || []).forEach((q, qi) => {
          const field = make('fieldset'); field.append(make('legend', q.q));
          q.options.forEach((option, oi) => {
            const label = make('label'), radio = make('input');
            radio.type = 'radio'; radio.name = 'answer' + qi; radio.value = oi; radio.required = true;
            label.append(radio, document.createTextNode(' ' + option)); field.append(label);
          }); form.append(field);
        });
        const submit = make('button', item.hasQuiz ? '验证并查看联系方式' : '查看联系方式', 'primary'); submit.type = 'submit';
        const state = make('p', '', 'small'); state.setAttribute('role', 'status');
        form.append(submit, state);
        form.addEventListener('submit', async event => {
          event.preventDefault(); submit.disabled = true;
          try {
            const answers = (item.quiz || []).map((_, index) => Number(new FormData(form).get('answer' + index)));
            const response = await api.post('/api/items/' + id + '/verify', { answers });
            if (response.correct) { contact.textContent = '联系方式：' + response.contact; form.remove(); }
            else state.textContent = response.message;
          } catch (e) { state.textContent = e.message; } finally { submit.disabled = false; }
        }); body.append(form);
      }
      if (item.status !== 'active') body.append(make('p', '该启事已结案或撤销，暂不可解锁联系方式。'));
      const similar = make('button', '查找这条启事的相似线索 →', 'text-button');
      similar.type = 'button'; similar.addEventListener('click', () => { el('itemDialog').close(); fill('查找与物品 ' + id + ' 相似的启事'); });
      body.append(similar);
    } catch (error) { if (version === detailVersion) body.replaceChildren(make('p', error.message)); }
  }
  welcome();
  const params = new URLSearchParams(location.search);
  if (/^[1-9]\d*$/.test(params.get('item') || '')) fill('查找与物品 ' + params.get('item') + ' 相似的启事');
  else if (params.get('q')) fill(params.get('q').slice(0, 2000));
}());
