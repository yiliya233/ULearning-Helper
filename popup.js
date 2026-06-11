// ============================================================
// 优学院自动答题 - Popup Script
// ============================================================

const DEFAULT_SELECTORS = {
  question: '.question-item, .exam-question, .ques-item, .questionContent, .exam-paper .question',
  questionText: '.question-text, .topic-text, .ques-text, .question-title, .stem, .questionBody',
  options: '.option-item, .answer-item, .ques-option, .option, .question-option li',
  blankInput: 'input[type="text"], input.blank-input, .blank-input input',
  essayTextarea: 'textarea, .essay-answer textarea, .answer-textarea',
  submitBtn: '.submit-btn, .next-btn, .save-btn, .btn-submit, .exam-submit, button[class*="submit"], button[class*="next"]',
  optionText: '.option-text, .option-content, span, label, .text',
  optionClick: 'input[type="radio"], input[type="checkbox"], label, .option-label',
  optionLetter: '.option-letter, .option-index, .letter'
};

// ========== DOM引用 ==========
const $ = id => document.getElementById(id);

const apiUrlInput = $('apiUrl');
const apiKeyInput = $('apiKey');
const modelInput = $('model');
const saveBtn = $('saveBtn');
const testBtn = $('testBtn');
const configStatus = $('configStatus');

const startBtn = $('startBtn');
const stopBtn = $('stopBtn');
const progressBar = $('progressBar');
const totalQ = $('totalQ');
const doneQ = $('doneQ');
const failQ = $('failQ');
const logContainer = $('logContainer');

const advancedToggle = $('advancedToggle');
const advancedContent = $('advancedContent');
const saveSelectorsBtn = $('saveSelectorsBtn');
const resetSelectorsBtn = $('resetSelectorsBtn');
const inspectBtn = $('inspectBtn');
const selectorStatus = $('selectorStatus');

const selectorFields = {
  question: $('selQuestion'),
  questionText: $('selQText'),
  options: $('selOptions'),
  blankInput: $('selBlank'),
  essayTextarea: $('selEssay'),
  submitBtn: $('selSubmit')
};

// ========== 初始化 ==========
document.addEventListener('DOMContentLoaded', () => {
  loadSavedConfig();
  loadSavedSelectors();
  loadPersistedLogs();
  setupEventListeners();
  setupStorageListener();
  checkTabStatus();
});

function loadPersistedLogs() {
  chrome.storage.local.get(['logs', 'currentStats'], data => {
    if (data.logs) {
      data.logs.forEach(entry => {
        addLogEntry(entry.message, entry.level, entry.time);
      });
    }
    if (data.currentStats) {
      updateStats(data.currentStats);
    }
  });
}

function setupStorageListener() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.logs && changes.logs.newValue) {
      const newLogs = changes.logs.newValue;
      const lastLog = newLogs[newLogs.length - 1];
      if (lastLog) {
        addLogEntry(lastLog.message, lastLog.level, lastLog.time);
      }
    }
    if (changes.currentStats && changes.currentStats.newValue) {
      updateStats(changes.currentStats.newValue);
    }
  });
}

function loadSavedConfig() {
  chrome.storage.local.get(['apiUrl', 'apiKey', 'model'], data => {
    if (data.apiUrl) apiUrlInput.value = data.apiUrl;
    if (data.apiKey) apiKeyInput.value = data.apiKey;
    if (data.model) modelInput.value = data.model;
  });
}

function loadSavedSelectors() {
  chrome.storage.local.get(['customSelectors'], data => {
    if (data.customSelectors) {
      Object.keys(data.customSelectors).forEach(key => {
        if (selectorFields[key] && data.customSelectors[key]) {
          selectorFields[key].value = data.customSelectors[key];
        }
      });
    }
  });
}

function setupEventListeners() {
  saveBtn.addEventListener('click', saveConfig);
  testBtn.addEventListener('click', testApiConnection);
  startBtn.addEventListener('click', startAnswering);
  stopBtn.addEventListener('click', stopAnswering);
  advancedToggle.addEventListener('click', toggleAdvanced);
  saveSelectorsBtn.addEventListener('click', saveSelectors);
  resetSelectorsBtn.addEventListener('click', resetSelectors);
  inspectBtn.addEventListener('click', inspectPage);
}

// ========== 配置保存 ==========
function saveConfig() {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim();

  if (!apiUrl) {
    showStatus(configStatus, '请输入API地址', 'error');
    return;
  }
  if (!apiKey) {
    showStatus(configStatus, '请输入API Key', 'error');
    return;
  }

  chrome.storage.local.set({ apiUrl, apiKey, model: model || 'gpt-4o-mini' }, () => {
    showStatus(configStatus, '✅ 配置已保存', 'success');
  });
}

// ========== 测试API ==========
async function testApiConnection() {
  const apiUrl = apiUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();
  const model = modelInput.value.trim() || 'gpt-4o-mini';

  if (!apiUrl || !apiKey) {
    showStatus(configStatus, '请先填写API地址和Key', 'error');
    return;
  }

  testBtn.disabled = true;
  testBtn.textContent = '⏳ 测试中...';
  showStatus(configStatus, '正在测试API连接...', 'info');

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: '回复"OK"两个字母' }],
        temperature: 0,
        max_tokens: 256
      })
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data.error?.message || data.message || JSON.stringify(data).substring(0, 200);
      showStatus(configStatus, `❌ API错误(${response.status}): ${errMsg}`, 'error');
      addLog(`API测试失败: ${errMsg}`, 'error');
      return;
    }

    // 打印原始响应用于调试
    const rawResp = JSON.stringify(data);
    addLog(`API原始响应: ${rawResp.substring(0, 500)}`, 'info');

    // 检查响应格式 - 兼容多种API
    let content = null;

    // OpenAI / 中转站 标准格式
    if (data.choices && data.choices.length > 0) {
      const choice = data.choices[0];
      content = choice.message?.content || choice.text || choice.delta?.content || null;
      // 推理模型：content为空时从reasoning_content提取
      if (!content && choice.message?.reasoning_content) {
        content = choice.message.reasoning_content;
      }
    }
    // Claude 格式
    if (!content && data.content && Array.isArray(data.content)) {
      content = data.content.map(c => c.text || '').join('');
    }
    // 通用格式
    if (!content && data.response) content = data.response;
    if (!content && data.result) content = data.result;
    if (!content && data.answer) content = data.answer;
    if (!content && data.output) content = data.output;
    // data 本身就是字符串
    if (!content && typeof data === 'string') content = data;
    // message 字段
    if (!content && data.message && typeof data.message === 'string') content = data.message;

    if (content && typeof content === 'string' && content.trim().length > 0) {
      showStatus(configStatus, `✅ API连接成功！AI回复: "${content.trim().substring(0, 50)}"`, 'success');
      addLog(`API测试成功，模型: ${model}，回复: ${content.trim()}`, 'success');
    } else {
      showStatus(configStatus, `⚠️ 格式异常，详见日志。原始响应: ${rawResp.substring(0, 100)}`, 'error');
      addLog(`无法解析响应内容，原始数据: ${rawResp.substring(0, 500)}`, 'error');
    }
  } catch (err) {
    showStatus(configStatus, `❌ 网络错误: ${err.message}`, 'error');
    addLog(`API测试网络错误: ${err.message}`, 'error');
  } finally {
    testBtn.disabled = false;
    testBtn.textContent = '🧪 测试API连接';
  }
}

// ========== 检测页面元素 ==========
function inspectPage() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes('ulearning.cn')) {
      showStatus(selectorStatus, '请先打开优学院页面', 'error');
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'INSPECT' }, response => {
      if (chrome.runtime.lastError) {
        showStatus(selectorStatus, '无法连接到页面，请刷新后重试', 'error');
        return;
      }
      if (response && response.result) {
        const r = response.result;
        const msg = `题目:${r.questions} 选项:${r.options} 填空:${r.blanks} 文本域:${r.textareas}`;
        showStatus(selectorStatus, `🔍 ${msg}`, r.questions > 0 ? 'success' : 'error');
        addLog(msg, 'info');
        if (r.qDetails) {
          r.qDetails.forEach((q, i) => addLog(`题目${i}: <${q.tag}> class="${q.class}"`, 'info'));
        }
        if (r.oDetails) {
          r.oDetails.forEach((o, i) => addLog(`选项${i}: <${o.tag}> class="${o.class}" text="${o.text}"`, 'info'));
        }
        if (r.questions === 0) {
          addLog('⚠ 未找到题目，请在高级设置中调整选择器', 'error');
        }
        if (r.options === 0 && r.questions > 0) {
          addLog('⚠ 找到题目但没找到选项，请调整"选项列表"选择器', 'error');
        }
      }
    });
  });
}

// ========== 选择器 ==========
function saveSelectors() {
  const customSelectors = {};
  Object.keys(selectorFields).forEach(key => {
    const val = selectorFields[key].value.trim();
    if (val) customSelectors[key] = val;
  });
  chrome.storage.local.set({ customSelectors }, () => {
    showStatus(selectorStatus, '✅ 选择器已保存', 'success');
  });
}

function resetSelectors() {
  Object.keys(selectorFields).forEach(key => {
    selectorFields[key].value = DEFAULT_SELECTORS[key] || '';
  });
  chrome.storage.local.remove('customSelectors', () => {
    showStatus(selectorStatus, '已恢复默认选择器', 'info');
  });
}

function toggleAdvanced() {
  advancedToggle.classList.toggle('open');
  advancedContent.classList.toggle('open');
}

// ========== 答题控制 ==========
function startAnswering() {
  chrome.storage.local.get(['apiUrl', 'apiKey'], data => {
    if (!data.apiUrl || !data.apiKey) {
      showStatus(configStatus, '请先配置API地址和Key', 'error');
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const tab = tabs[0];
      if (!tab || !tab.url || !tab.url.includes('ulearning.cn')) {
        addLog('当前页面不是优学院，请先打开优学院考试页面', 'error');
        return;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'START' }, response => {
        if (chrome.runtime.lastError) {
          addLog('无法连接到页面，请刷新页面后重试', 'error');
          return;
        }
        if (response && response.reason === 'already_running') {
          addLog('答题已在运行中', 'info');
          startBtn.disabled = true;
          stopBtn.disabled = false;
          return;
        }
        startBtn.disabled = true;
        stopBtn.disabled = false;
        addLog('已发送开始指令', 'info');
      });
    });
  });
}

function stopAnswering() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs[0]) {
      chrome.tabs.sendMessage(tabs[0].id, { type: 'STOP' });
    }
    startBtn.disabled = false;
    stopBtn.disabled = true;
  });
}

function checkTabStatus() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab || !tab.url || !tab.url.includes('ulearning.cn')) {
      addLog('⚠ 请先打开优学院 (ulearning.cn) 的考试页面', 'error');
      startBtn.disabled = true;
      return;
    }

    // 检查content script是否已注入
    chrome.tabs.sendMessage(tab.id, { type: 'PING' }, response => {
      if (chrome.runtime.lastError) {
        addLog('正在加载插件，请稍候...', 'info');
        return;
      }
      if (response && response.running) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        updateStats(response.stats);
        addLog('答题进行中...', 'info');
      } else {
        addLog('✅ 就绪，点击开始答题', 'success');
      }
    });
  });
}

// ========== 消息监听 ==========
chrome.runtime.onMessage.addListener((msg) => {
  switch (msg.type) {
    case 'LOG':
      addLog(msg.message, msg.level);
      break;
    case 'PROGRESS':
      if (msg.stats) updateStats(msg.stats);
      break;
    case 'STARTED':
      startBtn.disabled = true;
      stopBtn.disabled = false;
      break;
    case 'FINISHED':
    case 'STOPPED':
      startBtn.disabled = false;
      stopBtn.disabled = true;
      if (msg.stats) updateStats(msg.stats);
      break;
  }
});

// ========== UI更新 ==========
function showStatus(el, text, type) {
  el.textContent = text;
  el.className = `status ${type}`;
  setTimeout(() => {
    el.className = 'status';
  }, 3000);
}

function updateStats(stats) {
  totalQ.textContent = stats.total || 0;
  doneQ.textContent = stats.done || 0;
  failQ.textContent = stats.fail || 0;

  const total = stats.total || 0;
  const done = stats.done || 0;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;
  progressBar.style.width = `${percent}%`;
}

function addLog(message, level = 'info') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  addLogEntry(message, level, time);
}

function addLogEntry(message, level = 'info', time) {
  const entry = document.createElement('div');
  entry.className = `log-entry ${level}`;
  if (!time) time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  entry.textContent = `[${time}] ${message}`;
  logContainer.appendChild(entry);
  logContainer.scrollTop = logContainer.scrollHeight;

  // 最多保留100条日志
  while (logContainer.children.length > 100) {
    logContainer.removeChild(logContainer.firstChild);
  }
}
