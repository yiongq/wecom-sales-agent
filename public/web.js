function startWebChat() {
  const config = JSON.parse(document.getElementById('web-config').textContent);
  const get = (id) => document.getElementById(id);
  const msgs = get('msgs');
  const input = get('input');
  const sendBtn = get('sendBtn');
  const endBtn = get('endBtn');
  const retryBtn = get('retryBtn');
  const chips = get('chips');
  const api = `/api/web/${encodeURIComponent(config.key)}`;
  let ready = false;
  let busy = false;
  let pending = null;
  let stream = null;
  let reconnectTimer = null;
  let reconnectDelay = 1000;
  let live = false;
  let lastTs = 0;
  let typing = null;
  const menus = new Set();

  get('title').textContent = config.title;
  document.title = config.title;
  if (config.privacyLink) {
    // 版本是否已发布由服务端决定；导航固定走本站隐私页面。
    get('privacy').href = '/privacy';
    get('privacy').hidden = false;
  }
  function node(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function notice(text = '') {
    get('notice').textContent = text;
    get('notice').hidden = !text;
  }
  function controls() {
    input.disabled = busy || !ready || !!pending;
    sendBtn.disabled = busy || !ready || !!pending;
    endBtn.disabled = busy || !ready;
    retryBtn.disabled = busy;
    retryBtn.hidden = busy || (ready && !pending);
    for (const button of chips.querySelectorAll('button')) button.disabled = sendBtn.disabled;
    for (const menu of menus) {
      for (const button of menu.querySelectorAll('button')) button.disabled = busy || !!pending;
    }
  }
  function scrollBottom() {
    msgs.scrollTop = msgs.scrollHeight;
  }
  function renderParts(wrap, parts) {
    const titles = { order: '订单详情', proposal: '行程方案书', site: '查看详情' };
    for (const part of parts) {
      if (part.kind !== 'link') continue;
      const card = node('a', 'link-card');
      card.href = part.url;
      card.target = '_blank';
      card.rel = 'noopener noreferrer';
      card.append(node('strong', '', titles[part.linkKind]), node('span', '', part.url));
      wrap.append(card);
    }
  }
  function addMessage(role, text, at = Date.now(), parts = []) {
    if (at - lastTs > 5 * 60_000) {
      msgs.append(node('div', 'time-chip', new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })));
    }
    lastTs = at;
    const me = role === 'customer';
    const human = !me && text.startsWith('【顾问】');
    const row = node('div', `row ${me ? 'me' : 'ai'}`);
    const wrap = node('div', 'bubble-wrap');
    row.append(node('div', 'avatar', me ? '我' : human ? '顾' : 'AI'), wrap);
    if (!me) wrap.append(node('div', 'nick', human ? '真人顾问' : `${config.title} · AI`));
    const bubble = node('div', 'bubble');
    bubble.textContent = text;
    wrap.append(bubble);
    renderParts(wrap, parts);
    msgs.append(row);
    scrollBottom();
    return wrap;
  }
  function showTyping() {
    typing = node('div', 'row ai typing');
    typing.setAttribute('aria-label', '正在回复');
    const bubble = node('div', 'bubble');
    bubble.append(node('i'), node('i'), node('i'));
    typing.append(node('div', 'avatar', 'AI'), bubble);
    msgs.append(typing);
    scrollBottom();
  }
  function stopEvents() {
    live = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (stream) stream.close();
    stream = null;
  }
  function connectEvents() {
    if (!live || stream) return;
    const source = new EventSource(`${api}/events`);
    stream = source;
    source.addEventListener('open', () => {
      reconnectDelay = 1000;
      if (!pending && !busy) notice();
    });
    source.addEventListener('push', (event) => {
      const data = JSON.parse(event.data);
      addMessage('agent', data.text, undefined, data.parts);
    });
    source.addEventListener('menu', (event) => {
      const data = JSON.parse(event.data);
      const wrap = addMessage('agent', data.text, undefined, data.parts);
      const actions = node('div', 'menu-actions');
      menus.add(actions);
      for (const item of data.buttons) {
        const button = node('button', 'consent-btn', item.label);
        button.type = 'button';
        button.addEventListener('click', () => {
          if (busy || pending || !ready) return;
          pending = { body: { menu: item.id, cid: crypto.randomUUID() }, actions };
          void transmit();
        });
        actions.append(button);
      }
      wrap.append(actions);
      controls();
      scrollBottom();
    });
    source.addEventListener('error', () => {
      source.close();
      if (stream !== source) return;
      stream = null;
      if (!live) return;
      if (!pending && !busy) notice('连接暂时断开，正在重新连接…');
      reconnectTimer = setTimeout(connectEvents, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
  }
  function ensureEvents() {
    live = true;
    connectEvents();
  }
  async function post(endpoint, body) {
    const response = await fetch(`${api}/${endpoint}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'x-web-chat': '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      if (response.status === 409) throw new Error('上一条消息还在处理，请稍后点重试。');
      if (response.status === 429) throw new Error('现在咨询有点多，请稍后点重试。');
      throw new Error('暂时未能完成，请点重试。');
    }
    return response.json();
  }
  async function transmit() {
    if (busy || !pending) return;
    busy = true;
    notice();
    controls();
    showTyping();
    try {
      const data = await post('messages', pending.body);
      if (data.reply) addMessage('agent', data.reply.text, undefined, data.reply.parts);
      if (pending.actions) {
        pending.actions.replaceChildren(node('span', '', '已记录您的选择'));
        menus.delete(pending.actions);
      }
      pending = null;
      ensureEvents();
    } catch (error) {
      notice(error instanceof Error ? error.message : '发送失败，请点重试。');
      // 服务端可能已经发了 cookie 并记录了消息；同 cid 重试恢复，事件连接也再试一次。
      ensureEvents();
    } finally {
      typing?.remove();
      typing = null;
      busy = false;
      controls();
      scrollBottom();
    }
  }
  function send(text) {
    text = text.trim();
    if (!ready || busy || pending || !text || text.length > 1000) return;
    pending = { body: { text, cid: crypto.randomUUID() } };
    chips.hidden = true;
    addMessage('customer', text);
    input.value = '';
    void transmit();
  }
  async function restore() {
    busy = true;
    controls();
    try {
      const response = await fetch(`${api}/history`, { credentials: 'same-origin', signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error('暂时无法加载咨询记录，请点重试。');
      const data = await response.json();
      if (data.messages.length) {
        msgs.replaceChildren();
        lastTs = 0;
        for (const message of data.messages) addMessage(message.role, message.text, message.at, message.parts);
        chips.hidden = true;
        ensureEvents();
      }
      ready = true;
      notice();
    } catch {
      notice('暂时无法加载咨询记录，请点重试。');
    } finally {
      busy = false;
      controls();
    }
  }
  get('composer').addEventListener('submit', (event) => {
    event.preventDefault();
    send(input.value);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(input.value);
    }
  });
  for (const button of chips.querySelectorAll('button')) button.addEventListener('click', () => send(button.dataset.q));
  retryBtn.addEventListener('click', () => void (ready ? transmit() : restore()));
  endBtn.addEventListener('click', async () => {
    if (busy || !ready) return;
    busy = true;
    controls();
    try {
      await post('end', {});
      stopEvents();
      pending = null;
      menus.clear();
      msgs.replaceChildren();
      lastTs = 0;
      input.value = '';
      chips.hidden = true;
      notice('本次咨询已结束。发送消息即可开始新的咨询。');
    } catch {
      notice('暂时无法结束咨询，请再点一次「结束咨询」。');
    } finally {
      busy = false;
      controls();
    }
  });
  window.addEventListener('pagehide', stopEvents);
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) void restore();
  });
  addMessage('agent', config.welcome, undefined, config.welcomeParts);
  chips.hidden = false;
  void restore();
}

if (typeof document !== 'undefined') startWebChat();
