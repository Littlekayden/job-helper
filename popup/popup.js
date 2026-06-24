// popup/popup.js — 设置面板逻辑

const $ = (id) => document.getElementById(id);

function send(type, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp || { ok: false });
    });
  });
}

function splitKw(str) {
  return (str || '')
    .split(/[,，\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function showHint(msg, isError = false) {
  const el = $('hint');
  el.textContent = msg;
  el.style.color = isError ? '#e54d42' : '#00a8a7';
  if (msg) setTimeout(() => { el.textContent = ''; }, 2500);
}

// 载入配置到表单
async function load() {
  const { settings } = await send('GET_SETTINGS');
  const s = settings;
  $('greeting').value = s.greeting || '';
  $('maxGreet').value = s.maxGreetPerRun ?? 30;
  $('minDelay').value = (s.minDelayMs ?? 3000) / 1000;
  $('maxDelay').value = (s.maxDelayMs ?? 6000) / 1000;
  const f = s.filter || {};
  $('filterEnabled').checked = !!f.enabled;
  $('includeKw').value = (f.includeKeywords || []).join(',');
  $('excludeKw').value = (f.excludeKeywords || []).join(',');
  $('minSalary').value = f.minSalary || 0;
  $('maxSalary').value = f.maxSalary || 0;
  $('excludeScale').value = (f.excludeCompanyScale || []).join(',');

  await loadStats();
}

async function loadStats() {
  const { stats } = await send('GET_STATS');
  if (stats) {
    $('st-today').textContent = stats.today;
    $('st-total').textContent = stats.total;
    $('st-skip').textContent = stats.skipped;
  }
}

// 从表单收集配置
function collect() {
  const minD = Math.max(1, parseFloat($('minDelay').value) || 3) * 1000;
  let maxD = Math.max(1, parseFloat($('maxDelay').value) || 6) * 1000;
  if (maxD < minD) maxD = minD;
  return {
    enabled: false,
    greeting: $('greeting').value.trim(),
    maxGreetPerRun: Math.max(1, parseInt($('maxGreet').value, 10) || 30),
    minDelayMs: minD,
    maxDelayMs: maxD,
    filter: {
      enabled: $('filterEnabled').checked,
      includeKeywords: splitKw($('includeKw').value),
      excludeKeywords: splitKw($('excludeKw').value),
      minSalary: Math.max(0, parseInt($('minSalary').value, 10) || 0),
      maxSalary: Math.max(0, parseInt($('maxSalary').value, 10) || 0),
      excludeCompanyScale: splitKw($('excludeScale').value)
    }
  };
}

async function save() {
  const settings = collect();
  const r = await send('SAVE_SETTINGS', { settings });
  showHint(r.ok ? '✓ 已保存' : '保存失败', !r.ok);
}

// 在当前 BOSS直聘 标签页运行
async function runOnPage() {
  await save();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/zhipin\.com/.test(tab.url || '')) {
    showHint('请先打开 BOSS直聘 职位列表页', true);
    return;
  }
  chrome.tabs.sendMessage(tab.id, { type: 'START_RUN' }, () => {
    if (chrome.runtime.lastError) {
      showHint('页面未就绪，请刷新后重试', true);
    } else {
      showHint('▶ 已在当前页启动');
      window.close();
    }
  });
}

async function reset() {
  const r = await send('RESET_STATS');
  if (r.ok) {
    await loadStats();
    showHint('统计与去重记录已清空');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  load();
  $('saveBtn').addEventListener('click', save);
  $('runBtn').addEventListener('click', runOnPage);
  $('resetBtn').addEventListener('click', reset);
});
