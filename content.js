// ============================================================
// 优学院自动答题 - Content Script v2 (悬浮窗)
// ============================================================

(function () {
  'use strict';
  if (window.__autoAnswerLoaded) return;
  window.__autoAnswerLoaded = true;

  const DEFAULT_SEL = {
    question: '.question-item',
    questionText: '.question-title, .richtext-container.question-title, .title-text, .stem',
    options: '.answer-area label, .choice-list label',
    optionClick: 'input[type="radio"], input[type="checkbox"]',
    blankInput: 'input[type="text"]',
    essayTextarea: 'textarea',
    submitBtn: 'button.submit-button, .submit-button, .el-button--primary, .ul-button--primary'
  };
  let sel = { ...DEFAULT_SEL };
  let config = { apiUrl: '', apiKey: '', model: 'gpt-4o-mini' };
  let isRunning = false;
  let stats = { total: 0, done: 0, fail: 0 };
  let isRetrying = false;

  // 答案记忆：题目文本 → 正确答案
  let answerMemory = {};
  let flippedKeys = new Set();
  function memKey(text) { return text.replace(/\s+/g, '').substring(0, 80); }
  function loadMemory() {
    return new Promise(resolve => {
      if (!ctxValid()) { resolve(); return; }
      try {
        chrome.storage.local.get('answerMemory', d => {
          if (d.answerMemory) answerMemory = d.answerMemory;
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }
  function saveMemory() {
    if (!ctxValid()) return;
    try { chrome.storage.local.set({ answerMemory }); } catch (e) {}
  }

  const $ = id => document.getElementById(id);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const randSleep = (min, max) => sleep(min + Math.random() * (max - min));
  const interruptibleSleep = ms => new Promise(r => {
    const start = Date.now();
    const check = () => {
      if (!isRunning || Date.now() - start >= ms) { r(); return; }
      setTimeout(check, 100);
    };
    check();
  });

  function humanClick(el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2 + (Math.random() - 0.5) * 10;
    const cy = r.top + r.height / 2 + (Math.random() - 0.5) * 10;
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
  }
  const qAll = s => Array.from(document.querySelectorAll(s));

  // 检查扩展上下文是否有效
  function ctxValid() {
    try { return !!chrome.runtime?.id; } catch (e) { return false; }
  }

  function loadConfig() {
    return new Promise(resolve => {
      if (!ctxValid()) { resolve(); return; }
      try {
        chrome.storage.local.get(['apiUrl', 'apiKey', 'model', 'customSelectors'], d => {
          if (chrome.runtime.lastError) { resolve(); return; }
          if (d.apiUrl) config.apiUrl = d.apiUrl;
          if (d.apiKey) config.apiKey = d.apiKey;
          if (d.model) config.model = d.model;
          if (d.customSelectors) Object.assign(sel, d.customSelectors);
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  // ========== 面板 HTML ==========
  const PANEL_HTML = `
  <div id="aa-header">
    <span id="aa-collapse-btn">▼</span>
    <span id="aa-status-dot"></span>
    <span id="aa-title">ULearning Helper</span>
    <span id="aa-inline-stats" title="记忆题数"><b id="aa-it">0</b>/<span id="aa-ia">0</span></span>
    <span id="aa-settings-btn" title="设置">⚙</span>
  </div>
  <div id="aa-body">
    <div id="aa-controls">
      <button class="aa-ctrl-btn" id="aa-start">▶ 开始</button>
      <button class="aa-ctrl-btn" id="aa-stop" disabled>■ 停止</button>
    </div>
    <div id="aa-stats-row">
      <div class="aa-s"><div class="aa-s-val" id="aa-total">0</div><div class="aa-s-lbl">总</div></div>
      <div class="aa-s"><div class="aa-s-val" id="aa-done">0</div><div class="aa-s-lbl">成</div></div>
      <div class="aa-s"><div class="aa-s-val" id="aa-fail">0</div><div class="aa-s-lbl">败</div></div>
    </div>
    <div id="aa-progress-bar"><div id="aa-progress-fill"></div></div>
    <div id="aa-mini-log"></div>
  </div>`;

  // ========== 面板挂载 ==========
  function setupPanel() {
    const el = document.createElement('div');
    el.id = 'aa-panel';
    el.innerHTML = PANEL_HTML;
    document.body.appendChild(el);

    // 折叠
    $('aa-header').addEventListener('click', e => {
      if (e.target.closest('#aa-settings-btn') || e.target.closest('button')) return;
      el.classList.toggle('collapsed');
    });

    // 拖拽
    let drag = false, ox, oy;
    $('aa-header').addEventListener('mousedown', e => {
      if (e.target.closest('#aa-settings-btn') || e.target.closest('button')) return;
      drag = true;
      ox = e.clientX - el.offsetLeft;
      oy = e.clientY - el.offsetTop;
      document.addEventListener('mousemove', onDrag);
      document.addEventListener('mouseup', onDragEnd);
      e.preventDefault();
    });
    function onDrag(e) {
      if (!drag) return;
      el.style.left = (e.clientX - ox) + 'px';
      el.style.top = (e.clientY - oy) + 'px';
      el.style.right = 'auto';
    }
    function onDragEnd() {
      drag = false;
      document.removeEventListener('mousemove', onDrag);
      document.removeEventListener('mouseup', onDragEnd);
    }

    // 设置按钮
    $('aa-settings-btn').addEventListener('click', () => {
      try {
        chrome.runtime.sendMessage({ type: 'OPEN_SETTINGS' }, () => {
          if (chrome.runtime.lastError) {
            window.open(chrome.runtime.getURL('settings.html'), '_blank');
          }
        });
      } catch (e) {
        // 扩展上下文失效，刷新页面
        addLog('扩展已重载，请刷新页面', 'err');
      }
    });

    // 开始/停止
    $('aa-start').addEventListener('click', () => {
      if (isRunning) return;
      isRunning = true;
      startAnswering();
    });
    $('aa-stop').addEventListener('click', () => {
      isRunning = false;
      addLog('已停止', 'err');
      $('aa-start').disabled = false;
      $('aa-start').classList.remove('aa-running');
      $('aa-stop').disabled = true;
      setDot('done');
    });

    // 键盘隔离
    el.addEventListener('keydown', e => e.stopPropagation());
    el.addEventListener('keyup', e => e.stopPropagation());
    el.addEventListener('keypress', e => e.stopPropagation());

    // 加载配置
    loadConfig().then(() => {
      setDot('ready');
      addLog('就绪 — 点击 ⚙ 配置API', 'ok');
    });
  }

  // ========== UI ==========
  function setDot(s) { const d = $('aa-status-dot'); d.className = s; }

  function updateStats() {
    $('aa-total').textContent = stats.total;
    $('aa-done').textContent = stats.done;
    $('aa-fail').textContent = stats.fail;
    $('aa-it').textContent = stats.done;
    $('aa-ia').textContent = stats.total;
    $('aa-progress-fill').style.width = (stats.total > 0 ? Math.round(stats.done / stats.total * 100) : 0) + '%';
  }

  function addLog(msg, cls = '') {
    const log = $('aa-mini-log');
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const div = document.createElement('div');
    div.className = 'aa-log-line ' + cls;
    div.textContent = `${t} ${msg}`;
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 50) log.removeChild(log.firstChild);
    // 同步到 storage（扩展上下文失效时静默忽略）
    if (!ctxValid()) return;
    try {
      chrome.storage.local.get('logs', d => {
        if (chrome.runtime.lastError) return;
        const logs = d.logs || [];
        logs.push({ time: t, message: msg, level: cls || 'info' });
        if (logs.length > 200) logs.splice(0, logs.length - 200);
        chrome.storage.local.set({ logs });
      });
    } catch (e) { /* 扩展已重载 */ }
  }

  // ========== AI ==========
  async function callAI(question, options, type) {
    if (!config.apiUrl || !config.apiKey) throw new Error('未配置API，请点击 ⚙ 设置');
    const optText = options.map(o => `${String.fromCharCode(65 + o.index)}. ${o.text}`).join('\n');
    const prompts = {
      single: `你是答题助手。这是一道单选题，只回复一个大写字母（如A），不要回复任何其他内容。\n题目：${question}\n${optText}`,
      multiple: `你是答题助手。这是一道多选题，只回复大写字母（如ABD），不要回复任何其他内容。\n题目：${question}\n${optText}`,
      judgement: `你是答题助手。这是一道判断题，只回复"对"或"错"，不要回复任何其他内容。\n题目：${question}`,
      blank: `你是答题助手。这是一道填空题，只回复答案，多空用|||分隔，不要回复任何其他内容。\n题目：${question}`,
      essay: `你是答题助手。这是一道简答题，简洁回答，不要回复任何其他内容。\n题目：${question}`
    };
    const r = await fetch(config.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: [{ role: 'user', content: prompts[type] || `请回答：${question}\n${optText}` }], temperature: 0, max_tokens: 4096 })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(`API ${r.status}: ${d.error?.message || '未知'}`);
    const c = d.choices?.[0]?.message?.content || d.choices?.[0]?.message?.reasoning_content || d.choices?.[0]?.text || '';
    if (!c.trim()) throw new Error('返回为空');
    return c.trim();
  }

  // ========== 题目 ==========
  function detectType(c) {
    const t = c.innerText || '';
    const title = c.querySelector('.title')?.innerText || '';
    // 优先通过标题判断
    if (title.includes('多选')) return 'multiple';
    if (title.includes('判断')) return 'judgement';
    if (title.includes('单选')) return 'single';
    if (title.includes('填空')) return 'blank';
    if (title.includes('简答') || title.includes('论述')) return 'essay';
    // 通过元素类型判断
    if (c.querySelector(sel.essayTextarea)) return 'essay';
    if (c.querySelector(sel.blankInput)) return 'blank';
    if (c.querySelector('input[type="checkbox"]')) return 'multiple';
    if (c.querySelector('input[type="radio"]')) return 'single';
    return 'unknown';
  }

  function extractQuestion(c) {
    const textEl = c.querySelector(sel.questionText);
    const text = textEl ? textEl.innerText.trim() : c.innerText.split('\n').map(l => l.trim()).filter(l => l.length > 2)[0] || '';
    const type = detectType(c);
    const options = [];
    if (['single', 'multiple', 'judgement'].includes(type)) {
      qAll(sel.options).forEach(el => {
        if (!c.contains(el)) return;
        options.push({ index: options.length, text: el.innerText.trim().replace(/^[A-Z][.\s]+/, ''), element: el });
      });
    }
    return { type, text, options, element: c };
  }

  // ========== 填写 ==========
  function clickOpt(c, idx) {
    const vueItems = c.querySelectorAll('.ul-radio, .el-radio, .ul-checkbox, .el-checkbox');
    if (vueItems[idx]) { humanClick(vueItems[idx]); return true; }
    const inners = c.querySelectorAll('.ul-radio__inner, .el-radio__inner');
    if (inners[idx]) { humanClick(inners[idx]); return true; }
    const labels = c.querySelectorAll('label');
    if (labels[idx]) { humanClick(labels[idx]); return true; }
    const inputs = c.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    if (inputs[idx]) { if (inputs[idx].checked) return true; humanClick(inputs[idx]); return true; }
    return false;
  }

  async function fillAnswer(c, q, answer) {
    const m = answer.match(/^([A-Z])/i);
    switch (q.type) {
      case 'single': {
        if (m && clickOpt(c, m[1].toUpperCase().charCodeAt(0) - 65)) return true;
        const opts = [];
        c.querySelectorAll(sel.options).forEach(el => { if (c.contains(el)) opts.push(el); });
        for (let i = 0; i < opts.length; i++) if (opts[i].innerText.includes(answer)) return clickOpt(c, i);
        const radios = c.querySelectorAll('input[type="radio"]');
        if (radios.length && m) { const i = m[1].toUpperCase().charCodeAt(0) - 65; if (radios[i]) { humanClick(radios[i]); return true; } }
        addLog(`单选匹配失败 opts=${opts.length} radio=${radios.length} ans="${answer}"`, 'err');
        return false;
      }
      case 'multiple': {
        const ls = answer.toUpperCase().match(/[A-Z]/g);
        if (ls && ls.length <= 6) {
          for (const l of ls) {
            clickOpt(c, l.charCodeAt(0) - 65);
            await sleep(80);
          }
          return true;
        }
        // 答案不是字母格式，不乱点
        addLog(`多选答案格式异常: "${answer.substring(0, 20)}"`, 'err');
        return false;
      }
      case 'judgement': {
        const t = /对|正确|√|true/i.test(answer);
        const f = /错|不正确|×|false/i.test(answer);
        if (!t && !f) { addLog(`判断题答案无法识别: "${answer}"`, 'err'); return false; }
        const radioItems = c.querySelectorAll('.ul-radio, .el-radio');
        if (radioItems.length >= 2) {
          humanClick(radioItems[f ? 1 : 0]);
          return true;
        }
        const labels = c.querySelectorAll('label');
        if (labels.length >= 2) {
          humanClick(labels[f ? 1 : 0]);
          return true;
        }
        const radios = c.querySelectorAll('input[type="radio"]');
        if (radios.length >= 2) {
          humanClick(radios[f ? 1 : 0]);
          return true;
        }
        addLog(`判断题匹配失败`, 'err');
        return false;
      }
      case 'blank': {
        const bs = c.querySelectorAll(sel.blankInput);
        const as = answer.split('|||').map(a => a.trim());
        bs.forEach((inp, i) => { inp.value = as[i] || as[0] || answer; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true })); });
        return bs.length > 0;
      }
      case 'essay': {
        const ta = c.querySelector(sel.essayTextarea);
        if (!ta) return false;
        ta.value = answer; ta.dispatchEvent(new Event('input', { bubbles: true })); ta.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      default: return m ? clickOpt(c, m[1].toUpperCase().charCodeAt(0) - 65) : false;
    }
  }

  function highlight(el, s) {
    el.classList.add('auto-answer-highlight');
    el.classList.remove('auto-answer-done', 'auto-answer-error');
    if (s) el.classList.add('auto-answer-' + s);
    let b = el.querySelector('.auto-answer-badge');
    if (!b) { b = document.createElement('span'); b.className = 'auto-answer-badge'; el.style.position = 'relative'; el.appendChild(b); }
    b.textContent = s === 'done' ? '✓' : s === 'error' ? '✗' : '…';
    b.className = 'auto-answer-badge ' + (s || '');
  }

  // ========== 从提交后的DOM提取正确答案 ==========
  function extractCorrectAnswer(c, type) {
    const fullText = c.innerText || '';

    // 方法1：从 .answer-area .correct 提取（优学院实际结构）
    const correctEl = c.querySelector('.answer-area .correct span:last-child')
                   || c.querySelector('.correct-show-answer .correct span:last-child')
                   || c.querySelector('.correct-show-answer .correct')
                   || c.querySelector('[class*="correct-answer"]');
    if (correctEl) {
      const text = correctEl.innerText.replace(/正确答案[：:]?\s*/, '').trim();
      if (text && !/^我的/.test(text) && !/^回答/.test(text)) return text;
    }

    // 方法2：正则从全文提取
    const m1 = fullText.match(/正确答案[：:]\s*([^\n\r]+)/);
    if (m1 && m1[1].trim()) {
      const val = m1[1].trim();
      if (val && !/^回答/.test(val) && !/^我的/.test(val)) return val;
    }

    // 方法3：判断题特殊处理
    if (type === 'judgement') {
      if (/正确答案[：:]?\s*错/.test(fullText)) return '错';
      if (/正确答案[：:]?\s*对/.test(fullText)) return '对';
    }

    // 方法4：从 label.correct 提取
    const correctLabel = c.querySelector('label.correct, .answer-correct');
    if (correctLabel) {
      const input = correctLabel.querySelector('input');
      if (input && input.value) return input.value;
      const t = correctLabel.innerText.trim().replace(/^[A-Z][.\s]+/, '');
      if (t) return t;
    }

    return null;
  }

  // ========== 检测分数页面 ==========
  function checkScore() {
    const scoreEl = document.querySelector('.mastery-num .num, .grade-results .num');
    if (!scoreEl) return null;
    const text = scoreEl.innerText.trim();
    const match = text.match(/(\d+)/);
    return match ? parseInt(match[1]) : null;
  }

  // ========== 查找未答题目 ==========
  function findUnanswered() {
    return qAll(sel.question).filter(el => {
      if (el.getBoundingClientRect().height <= 0) return false;
      // 已答过的跳过
      if (el.classList.contains('auto-answer-done')) return false;
      // 已选中选项的跳过（radio/checkbox有checked）
      const checked = el.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
      if (checked) return false;
      return true;
    });
  }

  // ========== 主流程：逐题处理 + 答案记忆 + 自动重考 ==========
  async function startAnswering() {
    try {
    await loadConfig();
    await loadMemory();
    stats = { total: 0, done: 0, fail: 0 };
    updateStats();
    setDot('running');
    $('aa-start').disabled = true;
    $('aa-start').classList.add('aa-running');
    $('aa-stop').disabled = false;
    addLog(`开始答题 (记忆${Object.keys(answerMemory).length}题)`, 'ok');

    // 点击"去测验"进入第一章（重考时跳过）
    if (!isRetrying) {
      let firstQuizBtn = document.querySelector('.go-quiz, button.go-quiz, .ul-button.go-quiz');
      if (!firstQuizBtn) {
        firstQuizBtn = Array.from(document.querySelectorAll('button, a, span, div')).find(b => /去测验|去答题|开始测验|进入测验/.test(b.innerText?.trim()));
      }
      if (firstQuizBtn) {
        await randSleep(300, 800);
        humanClick(firstQuizBtn);
        addLog('已点击"去测验"，等待加载…', 'ok');
        // 等待题目出现
        for (let i = 0; i < 20; i++) {
          await interruptibleSleep(500);
          if (!isRunning) return;
          if (findUnanswered().length > 0) break;
        }
        if (!isRunning) return;

    } else {
        addLog('未找到"去测验"按钮', 'err');
      }
    } else {
      isRetrying = false;
      addLog('重考模式，跳过"去测验"', 'info');
    }

    // 清除旧的高亮标记（重考时）
    qAll('.auto-answer-done, .auto-answer-error, .auto-answer-highlight').forEach(el => {
      el.classList.remove('auto-answer-done', 'auto-answer-error', 'auto-answer-highlight');
    });
    qAll('.auto-answer-badge').forEach(el => el.remove());

    let round = 0;
    while (isRunning && round < 200 && ctxValid()) {
      round++;
      const cs = findUnanswered();
      if (!cs.length) { addLog('无更多题目', ''); break; }

      // 每次只处理第一道题（优学院逐题出现）
      const c = cs[0];
      await interruptibleSleep(300);
      if (c.classList.contains('auto-answer-done') || c.querySelector('input:checked')) {
        await interruptibleSleep(500);
        continue;
      }

        stats.total++;
        updateStats();

        const q = extractQuestion(c);
        if (q.text.length < 2) { stats.fail++; updateStats(); continue; }

        highlight(c, null);
        addLog(`[${q.type}] ${q.text.substring(0, 30)}`, 'info');

        // 优先用记忆中的正确答案
        const key = memKey(q.text);
        let answer = answerMemory[key];
        let fromMemory = false;
        // 校验记忆值是否有效
        if (answer && /[✓✗✘×√]/.test(answer)) {
          delete answerMemory[key];
          answer = null;
        }
        if (answer) {
          fromMemory = true;
          addLog(`📚 记忆: ${answer.substring(0, 20)}`, 'ok');
        } else {
          try {
            answer = await callAI(q.text, q.options, q.type);
          } catch (e) {
            highlight(c, 'error');
            stats.fail++;
            addLog(`✗ ${e.message}`, 'err');
            updateStats();
            continue;
          }
        }

        // 填写答案
        if (await fillAnswer(c, q, answer)) {
          highlight(c, 'done');
          stats.done++;
          addLog(`✓ ${fromMemory ? '记忆' : 'AI'}: ${answer.substring(0, 20)}`, 'ok');
        } else {
          highlight(c, 'error');
          stats.fail++;
          addLog(`✗ 匹配失败`, 'err');
        }
        updateStats();

        // 提交
        await randSleep(200, 600);
        let btn = c.querySelector('button.submit-button')
               || c.querySelector(sel.submitBtn)
               || c.querySelector('.ul-button--primary, .el-button--primary')
               || c.querySelector('.ul-button.submit-button')
               || Array.from(c.querySelectorAll('button')).find(b => /提交|确定/.test(b.innerText) && !b.disabled)
               || document.querySelector('button.submit-button:not([disabled])')
               || Array.from(document.querySelectorAll('button')).find(b => /提交|确定|确认|submit/i.test(b.innerText) && !b.disabled);
        if (btn && !btn.disabled) {
          humanClick(btn);
          addLog('提交', 'ok');

          // 等待反馈出现
          await interruptibleSleep(1000);
          const allStatus = document.querySelectorAll('.status');
          const allAreas = document.querySelectorAll('.answer-area');
          const statusEl = allStatus[allStatus.length - 1];
          const curAnswerArea = allAreas[allAreas.length - 1];
          const feedbackText = ((statusEl?.innerText || '') + ' ' + (curAnswerArea?.innerText || '')).trim();

          // 日志里显示反馈
          if (feedbackText) {
            if (/回答正确/.test(feedbackText)) {
              addLog(`✓ 回答正确`, 'ok');
            } else if (/回答错误/.test(feedbackText)) {
              const correctAns = curAnswerArea?.querySelector('.correct span:last-child')?.innerText || '';
              addLog(`✗ 回答错误 ${correctAns}`, 'err');
            }
          }

          // 判断题：检查反馈文本
          if (q.type === 'judgement') {
            if (/回答错误/.test(feedbackText) && !flippedKeys.has(key)) {
              let correct = /对/.test(answer) ? '错' : '对';
              flippedKeys.add(key);
              answerMemory[key] = correct;
              saveMemory();
              stats.fail++;
              updateStats();
              addLog(`判断题翻转: ${answer} → ${correct}`, 'ok');
            } else if (/回答正确/.test(feedbackText)) {
              answerMemory[key] = answer;
              saveMemory();
            }
          } else {
            // 其他题型：从 answer-area 提取正确答案
            let correct = null;
            if (curAnswerArea) {
              const correctSpan = curAnswerArea.querySelector('.correct span:last-child');
              if (correctSpan) correct = correctSpan.innerText.replace(/正确答案[：:]?\s*/, '').trim();
            }
            if (!correct) correct = extractCorrectAnswer(c, q.type);
            if (correct && correct.length > 0 && !/[✓✗✘×√]/.test(correct) && !/^回答/.test(correct) && !/^我的/.test(correct)) {
              answerMemory[key] = correct;
              saveMemory();
              if (correct !== answer) {
                stats.fail++;
                updateStats();
                addLog(`📝 正确答案: ${correct}`, 'ok');
              }
            }
          }
      } else {
        const allBtns = document.querySelectorAll('button');
        addLog(`提交按钮不可用 (页面共${allBtns.length}个按钮)`, 'err');
      }

      // 等待当前题被平台处理（随机延迟模拟人类）
      await randSleep(800, 2000);
      if (!isRunning) break;
    }

    // 检测分数，答错了才重考（必须答过题才检查）
    if (stats.total === 0) return;
    await interruptibleSleep(1500);
    if (!isRunning) return;
    const score = checkScore();
    if (score !== null) {
      addLog(`得分: ${score}%`, score >= 100 ? 'ok' : 'err');
      if (stats.fail > 0 && isRunning) {
        addLog(`有${stats.fail}题答错，准备重考…`, 'info');
        await interruptibleSleep(2000);
        if (!isRunning) return;
        const retryBtn = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('重新测验'));
        if (retryBtn) {
          isRetrying = true;
          humanClick(retryBtn);
          addLog('点击重新测验，等待加载…', 'ok');
          await interruptibleSleep(5000);
          if (!isRunning) return;
          if (isRunning) {
            startAnswering();
          }
          return;
        } else {
          addLog('未找到重新测验按钮', 'err');
        }
      }
    }

    // ========== 章节导航：进入下一章 ==========
    if (isRunning) {
      addLog('当前章节完成，准备进入下一章…', 'info');

      // 清除本章记忆
      answerMemory = {};
      flippedKeys = new Set();
      saveMemory();
      addLog('已清除本章记忆', 'ok');

      // 1) 点击 "下一个 >>"
      const nextBtn = Array.from(document.querySelectorAll('button')).find(b => /下一个/.test(b.innerText));
      if (nextBtn) {
        humanClick(nextBtn);
        addLog('点击"下一个"', 'ok');
        await interruptibleSleep(1000);
      } else {
        addLog('未找到"下一个"按钮', 'err');
      }

      // 2) 点击 "去测验"
      await interruptibleSleep(500);
      if (!isRunning) return;
      // 优先用类名精准匹配
      let quizBtn = document.querySelector('.go-quiz, button.go-quiz, .ul-button.go-quiz');
      if (!quizBtn) {
        quizBtn = Array.from(document.querySelectorAll('button, a, span, div')).find(b => /去测验|去答题|开始测验|进入测验/.test(b.innerText?.trim()));
      }
      if (quizBtn) {
        await randSleep(300, 800);
        humanClick(quizBtn);
        addLog('已点击"去测验"，等待加载…', 'ok');
        // 等待题目出现
        for (let i = 0; i < 20; i++) {
          await interruptibleSleep(500);
          if (!isRunning) return;
          if (findUnanswered().length > 0) break;
        }
        if (!isRunning) return;
        if (isRunning) startAnswering();
        return;
      } else {
        addLog('未找到"去测验"按钮，可能是最后一章', 'err');
      }
    }

    isRunning = false;
    $('aa-start').disabled = false;
    $('aa-start').classList.remove('aa-running');
    $('aa-stop').disabled = true;
    setDot('done');
    addLog(`完成 ${stats.done}/${stats.total}`, 'ok');
    } catch (e) {
      addLog(`运行出错: ${e.message}`, 'err');
      isRunning = false;
      $('aa-start').disabled = false;
      $('aa-start').classList.remove('aa-running');
      $('aa-stop').disabled = true;
      setDot('done');
    }
  }

  // ========== 初始化 ==========
  setupPanel();

  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === 'TOGGLE_PANEL') { const p = $('aa-panel'); if (p) p.style.display = p.style.display === 'none' ? '' : 'none'; sendResponse({ ok: true }); }
    if (msg.type === 'PING') sendResponse({ running: isRunning, stats });
    if (msg.type === 'START' && !isRunning) { isRunning = true; startAnswering(); sendResponse({ ok: true }); }
    if (msg.type === 'STOP') { isRunning = false; sendResponse({ ok: true }); }
    return true;
  });
})();
