// 点击图标 → 切换悬浮窗
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.url?.includes('ulearning.cn')) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
  } catch (e) {
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] }); } catch (_) {}
  }
});

// 打开设置页
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'OPEN_SETTINGS') {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
  }
});
