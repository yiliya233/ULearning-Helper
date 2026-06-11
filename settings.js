// ============================================================
// 优学院自动答题 - Settings Page
// ============================================================

const $ = id => document.getElementById(id);
const DEFAULT_SEL = {
  question: '.question-item',
  questionText: '.question-title, .richtext-container.question-title, .title-text, .stem',
  options: '.answer-area label, .choice-list label',
  optionClick: 'input[type="radio"], input[type="checkbox"]',
  blankInput: 'input[type="text"]',
  essayTextarea: 'textarea',
  submitBtn: 'button.submit-button, .submit-button, .el-button--primary'
};

function showMsg(el, text, ok) {
  el.textContent = text;
  el.className = 'msg show ' + (ok ? 'ok' : 'err');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = 'msg', 4000);
}

// ========== 加载 ==========
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['apiUrl', 'apiKey', 'model', 'customSelectors', 'logs'], d => {
    if (d.apiUrl) $('apiUrl').value = d.apiUrl;
    if (d.apiKey) $('apiKey').value = d.apiKey;
    if (d.model) $('model').value = d.model;
    const sel = d.customSelectors || DEFAULT_SEL;
    $('selQ').value = sel.question || DEFAULT_SEL.question;
    $('selQt').value = sel.questionText || DEFAULT_SEL.questionText;
    $('selOpt').value = sel.options || DEFAULT_SEL.options;
    $('selBlank').value = sel.blankInput || DEFAULT_SEL.blankInput;
    $('selEssay').value = sel.essayTextarea || DEFAULT_SEL.essayTextarea;
    $('selSubmit').value = sel.submitBtn || DEFAULT_SEL.submitBtn;
    renderLogs(d.logs || []);
  });

  // API 保存
  $('saveBtn').addEventListener('click', () => {
    const data = {
      apiUrl: $('apiUrl').value.trim(),
      apiKey: $('apiKey').value.trim(),
      model: $('model').value.trim() || 'gpt-4o-mini'
    };
    if (!data.apiUrl || !data.apiKey) { showMsg($('apiMsg'), '请填写 API 地址和 Key', false); return; }
    chrome.storage.local.set(data, () => showMsg($('apiMsg'), '已保存', true));
  });

  // API 测试
  $('testBtn').addEventListener('click', async () => {
    const url = $('apiUrl').value.trim();
    const key = $('apiKey').value.trim();
    const model = $('model').value.trim() || 'gpt-4o-mini';
    if (!url || !key) { showMsg($('apiMsg'), '请填写 API 地址和 Key', false); return; }
    $('testBtn').disabled = true;
    $('testBtn').textContent = '测试中…';
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: '回复OK' }], temperature: 0, max_tokens: 256 })
      });
      const d = await r.json();
      if (!r.ok) { showMsg($('apiMsg'), `错误 ${r.status}: ${d.error?.message || JSON.stringify(d).substring(0, 100)}`, false); return; }
      const c = d.choices?.[0]?.message?.content || d.choices?.[0]?.message?.reasoning_content || d.choices?.[0]?.text || '';
      if (c) showMsg($('apiMsg'), `成功 — AI: "${c.trim().substring(0, 30)}"`, true);
      else showMsg($('apiMsg'), `格式异常: ${JSON.stringify(d).substring(0, 150)}`, false);
    } catch (e) { showMsg($('apiMsg'), `网络错误: ${e.message}`, false); }
    finally { $('testBtn').disabled = false; $('testBtn').textContent = '测试连接'; }
  });

  // 选择器保存
  $('selSave').addEventListener('click', () => {
    const sel = {
      question: $('selQ').value.trim() || DEFAULT_SEL.question,
      questionText: $('selQt').value.trim() || DEFAULT_SEL.questionText,
      options: $('selOpt').value.trim() || DEFAULT_SEL.options,
      optionClick: DEFAULT_SEL.optionClick,
      blankInput: $('selBlank').value.trim() || DEFAULT_SEL.blankInput,
      essayTextarea: $('selEssay').value.trim() || DEFAULT_SEL.essayTextarea,
      submitBtn: $('selSubmit').value.trim() || DEFAULT_SEL.submitBtn
    };
    chrome.storage.local.set({ customSelectors: sel }, () => showMsg($('selMsg'), '已保存', true));
  });

  // 选择器恢复
  $('selReset').addEventListener('click', () => {
    $('selQ').value = DEFAULT_SEL.question;
    $('selQt').value = DEFAULT_SEL.questionText;
    $('selOpt').value = DEFAULT_SEL.options;
    $('selBlank').value = DEFAULT_SEL.blankInput;
    $('selEssay').value = DEFAULT_SEL.essayTextarea;
    $('selSubmit').value = DEFAULT_SEL.submitBtn;
    chrome.storage.local.remove('customSelectors', () => showMsg($('selMsg'), '已恢复默认', true));
  });

  // 检测（发消息到 content script）
  $('selInspect').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url?.includes('ulearning.cn')) { showMsg($('selMsg'), '请先打开优学院页面', false); return; }
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
      if (!resp) { showMsg($('selMsg'), '页面未响应，请刷新', false); return; }
      showMsg($('selMsg'), `运行中: ${resp.running ? '是' : '否'}，总${resp.stats?.total || 0}题`, true);
    } catch (e) { showMsg($('selMsg'), '无法连接页面，请刷新', false); }
  });

  // 日志
  $('logClear').addEventListener('click', () => {
    chrome.storage.local.set({ logs: [] }, () => { $('logBox').innerHTML = ''; });
  });
  $('logRefresh').addEventListener('click', () => {
    chrome.storage.local.get('logs', d => renderLogs(d.logs || []));
  });
});

function renderLogs(logs) {
  const box = $('logBox');
  box.innerHTML = '';
  if (!logs.length) {
    box.innerHTML = '<div style="color:#666;padding:10px">暂无日志</div>';
    return;
  }
  logs.slice(-100).forEach(l => {
    const div = document.createElement('div');
    div.className = l.level || '';
    div.textContent = `[${l.time}] ${l.message}`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}
