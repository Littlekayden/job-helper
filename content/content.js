// content/content.js
// Boss Hunter 内容脚本：在 BOSS直聘（zhipin.com）页面上执行
// 岗位解析、智能过滤、自动打招呼、批量沟通、去重与统计。
//
// 说明：BOSS直聘前端 DOM 结构会不定期变化，本脚本对每个关键元素都
// 提供多组候选选择器（selector fallback），并做了防御式解析，尽量保证
// 在结构调整后仍能工作。若官方大改版导致失效，只需更新 SELECTORS 即可。

(function () {
  'use strict';

  if (window.__bossHunterLoaded) return;
  window.__bossHunterLoaded = true;

  // ---------- 选择器（多候选，按顺序尝试） ----------
  const SELECTORS = {
    jobCard: [
      '.job-card-wrapper',
      'li.job-card-wrapper',
      '.job-list-box .job-card-box',
      'ul.rec-job-list li',
      '.search-job-result ul.job-list-box li'
    ],
    jobName: ['.job-name', '.job-card-left .job-name', '.job-title .job-name', 'span.job-name'],
    salary: ['.job-salary', '.salary', '.job-card-left .salary'],
    companyName: ['.company-name', '.company-name a', '.company-info .company-name'],
    companyTags: ['.company-tag-list', '.company-tag-list li', '.tag-list li'],
    jobDesc: ['.job-card-footer .tag-list', '.tag-list', '.job-card-footer'],
    greetBtn: [
      '.start-chat-btn',
      'button.start-chat-btn',
      '.op-btn-chat',
      'a.btn-startchat',
      '.btn-startchat'
    ],
    // 沟通对话框
    chatTextarea: [
      'textarea#chat-input',
      '.chat-input',
      'textarea.input-area',
      '.dialog-container textarea',
      'textarea[placeholder*="说点什么"]'
    ],
    chatSendBtn: [
      '.submit-btn',
      '.send-message',
      'button.btn-send',
      '.chat-op .btn-send',
      '.dialog-container .btn-v2.btn-sure-v2'
    ],
    dialogClose: ['.dialog-container .icon-close', '.boss-dialog .close', '.greet-dialog .close']
  };

  function pick(root, list) {
    for (const sel of list) {
      const el = (root || document).querySelector(sel);
      if (el) return el;
    }
    return null;
  }
  function pickAll(root, list) {
    for (const sel of list) {
      const els = (root || document).querySelectorAll(sel);
      if (els && els.length) return Array.from(els);
    }
    return [];
  }

  // ---------- 工具函数 ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function rand(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function text(el) {
    return (el?.textContent || '').trim();
  }

  // 解析薪资文本为 [下限K, 上限K]
  function parseSalary(str) {
    if (!str) return [0, 0];
    const s = str.replace(/\s/g, '');
    // 例：15-25K / 15-30K·14薪 / 8千-1.2万 / 面议
    const wan = /万/.test(s);
    const m = s.match(/(\d+(?:\.\d+)?)[kK千万]?-(\d+(?:\.\d+)?)[kK千万]?/);
    if (m) {
      let lo = parseFloat(m[1]);
      let hi = parseFloat(m[2]);
      if (wan) { lo *= 10; hi *= 10; } // 万 -> K
      else if (/千/.test(s)) { lo = lo; hi = hi; } // 千 ≈ K（粗略）
      return [lo, hi];
    }
    const single = s.match(/(\d+(?:\.\d+)?)[kK]/);
    if (single) {
      const v = parseFloat(single[1]);
      return [v, v];
    }
    return [0, 0];
  }

  // 生成岗位指纹用于去重（岗位名 + 公司名 + 薪资）
  function fingerprint(info) {
    return `${info.jobName}|${info.companyName}|${info.salaryText}`.replace(/\s+/g, '');
  }

  function send(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(resp || { ok: false });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });
  }

  // 等待元素出现
  async function waitFor(list, timeout = 8000, root = document) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = pick(root, list);
      if (el && el.offsetParent !== null) return el;
      await sleep(200);
    }
    return null;
  }

  // ---------- 状态 ----------
  let settings = null;
  let running = false;
  let stopRequested = false;

  // ---------- 岗位解析 ----------
  function parseCard(card) {
    const jobName = text(pick(card, SELECTORS.jobName));
    const salaryText = text(pick(card, SELECTORS.salary));
    const companyName = text(pick(card, SELECTORS.companyName));
    const tags = pickAll(card, SELECTORS.companyTags).map(text).join(' ');
    const desc = text(pick(card, SELECTORS.jobDesc));
    const [minS, maxS] = parseSalary(salaryText);
    return {
      jobName,
      salaryText,
      companyName,
      tags,
      desc,
      minSalary: minS,
      maxSalary: maxS,
      blob: `${jobName} ${companyName} ${tags} ${desc}`
    };
  }

  // ---------- 过滤判断 ----------
  function shouldGreet(info) {
    const f = settings.filter || {};
    if (!f.enabled) return { ok: true };

    if (Array.isArray(f.includeKeywords) && f.includeKeywords.length) {
      const hit = f.includeKeywords.some((k) => k && info.blob.includes(k));
      if (!hit) return { ok: false, reason: '不含必含关键词' };
    }
    if (Array.isArray(f.excludeKeywords) && f.excludeKeywords.length) {
      const bad = f.excludeKeywords.find((k) => k && info.blob.includes(k));
      if (bad) return { ok: false, reason: `命中排除词「${bad}」` };
    }
    if (Array.isArray(f.excludeCompanyScale) && f.excludeCompanyScale.length) {
      const bad = f.excludeCompanyScale.find((k) => k && info.tags.includes(k));
      if (bad) return { ok: false, reason: `公司规模排除「${bad}」` };
    }
    if (f.minSalary > 0 && info.maxSalary > 0 && info.maxSalary < f.minSalary) {
      return { ok: false, reason: `薪资上限 ${info.maxSalary}K < 期望下限 ${f.minSalary}K` };
    }
    if (f.maxSalary > 0 && info.minSalary > 0 && info.minSalary > f.maxSalary) {
      return { ok: false, reason: `薪资下限 ${info.minSalary}K > 期望上限 ${f.maxSalary}K` };
    }
    return { ok: true };
  }

  // ---------- 打招呼语渲染 ----------
  function renderGreeting(info) {
    return (settings.greeting || '')
      .replace(/\{jobName\}/g, info.jobName)
      .replace(/\{companyName\}/g, info.companyName)
      .replace(/\{bossName\}/g, '');
  }

  // 在输入框填入文本（兼容 React 受控组件）
  function setInputValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ---------- 单个岗位打招呼流程 ----------
  async function greetOne(card, info) {
    const btn = pick(card, SELECTORS.greetBtn);
    if (!btn) return { ok: false, reason: '未找到沟通按钮' };

    // 已经是“继续沟通”说明聊过了
    const btnText = text(btn);
    if (/继续沟通|已沟通/.test(btnText)) {
      return { ok: false, reason: '已沟通过' };
    }

    btn.scrollIntoView({ block: 'center' });
    await sleep(300);
    btn.click();

    // 等待沟通对话框出现
    const textarea = await waitFor(SELECTORS.chatTextarea, 8000);
    if (!textarea) {
      // 有些版本点击后直接跳转聊天页，无弹窗
      return { ok: false, reason: '未弹出沟通框（可能已跳转或被频控）' };
    }

    const greeting = renderGreeting(info);
    setInputValue(textarea, greeting);
    await sleep(rand(400, 900));

    const sendBtn = pick(document, SELECTORS.chatSendBtn);
    if (sendBtn && sendBtn.offsetParent !== null) {
      sendBtn.click();
    } else {
      // 回退：回车发送
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }
    await sleep(rand(600, 1200));

    // 关闭可能的弹窗
    const close = pick(document, SELECTORS.dialogClose);
    if (close && close.offsetParent !== null) {
      close.click();
      await sleep(400);
    }
    return { ok: true };
  }

  // ---------- 主循环 ----------
  async function run() {
    if (running) return;
    if (!settings) {
      const r = await send('GET_SETTINGS', {});
      settings = r.settings;
    }
    running = true;
    stopRequested = false;
    let greeted = 0;
    log(`▶ 开始运行（本轮上限 ${settings.maxGreetPerRun} 个）`);
    setPanelRunning(true);

    try {
      const cards = pickAll(document, SELECTORS.jobCard);
      if (!cards.length) {
        log('⚠ 未在当前页找到岗位卡片，请在「推荐/搜索职位」列表页运行。');
        return;
      }
      log(`共发现 ${cards.length} 个岗位卡片`);

      for (const card of cards) {
        if (stopRequested) { log('■ 已手动停止'); break; }
        if (greeted >= settings.maxGreetPerRun) { log('✓ 已达本轮上限'); break; }

        const info = parseCard(card);
        if (!info.jobName) continue;

        const fp = fingerprint(info);
        const dup = await send('CHECK_GREETED', { fingerprint: fp });
        if (dup.greeted) {
          log(`↷ 跳过（去重）：${info.jobName} - ${info.companyName}`);
          continue;
        }

        const verdict = shouldGreet(info);
        if (!verdict.ok) {
          await send('RECORD_SKIP', {});
          log(`✗ 跳过：${info.jobName} - ${info.companyName}（${verdict.reason}）`);
          continue;
        }

        const res = await greetOne(card, info);
        if (res.ok) {
          await send('RECORD_GREET', { fingerprint: fp });
          greeted += 1;
          log(`✓ 已打招呼 [${greeted}]：${info.jobName} - ${info.companyName} ${info.salaryText}`);
        } else {
          log(`· 未发送：${info.jobName}（${res.reason}）`);
        }

        const delay = rand(settings.minDelayMs, settings.maxDelayMs);
        await sleep(delay);
      }
      log(`完成，本轮共打招呼 ${greeted} 个。`);
    } catch (e) {
      log(`发生错误：${e}`);
    } finally {
      running = false;
      setPanelRunning(false);
    }
  }

  // ---------- 悬浮控制面板 ----------
  let panelEl, logEl;
  function buildPanel() {
    if (panelEl) return;
    panelEl = document.createElement('div');
    panelEl.id = 'boss-hunter-panel';
    panelEl.innerHTML = `
      <div class="bh-head">
        <span class="bh-title">🎯 Boss Hunter</span>
        <span class="bh-min" title="收起/展开">－</span>
      </div>
      <div class="bh-body">
        <div class="bh-stats">
          <span>今日 <b id="bh-today">0</b></span>
          <span>累计 <b id="bh-total">0</b></span>
          <span>跳过 <b id="bh-skip">0</b></span>
        </div>
        <div class="bh-actions">
          <button id="bh-start" class="bh-btn bh-primary">开始打招呼</button>
          <button id="bh-stop" class="bh-btn" disabled>停止</button>
        </div>
        <div class="bh-log" id="bh-log"></div>
      </div>`;
    document.body.appendChild(panelEl);
    logEl = panelEl.querySelector('#bh-log');

    panelEl.querySelector('#bh-start').addEventListener('click', () => run());
    panelEl.querySelector('#bh-stop').addEventListener('click', () => { stopRequested = true; });
    panelEl.querySelector('.bh-min').addEventListener('click', () => {
      panelEl.classList.toggle('bh-collapsed');
    });
    refreshStats();
  }

  function setPanelRunning(on) {
    if (!panelEl) return;
    panelEl.querySelector('#bh-start').disabled = on;
    panelEl.querySelector('#bh-stop').disabled = !on;
    refreshStats();
  }

  function log(msg) {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // eslint-disable-next-line no-console
    console.log('[BossHunter]', msg);
    if (!logEl) return;
    const line = document.createElement('div');
    line.className = 'bh-log-line';
    line.textContent = `[${time}] ${msg}`;
    logEl.appendChild(line);
    logEl.scrollTop = logEl.scrollHeight;
    while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
  }

  async function refreshStats() {
    const r = await send('GET_STATS', {});
    if (r.ok && panelEl) {
      panelEl.querySelector('#bh-today').textContent = r.stats.today;
      panelEl.querySelector('#bh-total').textContent = r.stats.total;
      panelEl.querySelector('#bh-skip').textContent = r.stats.skipped;
    }
  }

  // ---------- 消息监听（来自 popup/background） ----------
  chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
    if (msg?.type === 'SETTINGS_UPDATED') {
      settings = msg.settings;
      log('⚙ 配置已更新');
    } else if (msg?.type === 'START_RUN') {
      run();
    } else if (msg?.type === 'STOP_RUN') {
      stopRequested = true;
    } else if (msg?.type === 'PING') {
      sendResponse({ ok: true, onJobPage: pickAll(document, SELECTORS.jobCard).length > 0 });
      return true;
    }
  });

  // ---------- 初始化 ----------
  async function init() {
    const r = await send('GET_SETTINGS', {});
    settings = r.settings;
    // 仅在存在岗位列表的页面挂载面板
    const tryMount = () => {
      if (pickAll(document, SELECTORS.jobCard).length) {
        buildPanel();
        return true;
      }
      return false;
    };
    if (!tryMount()) {
      // 列表为异步加载，监听 DOM 变化
      const obs = new MutationObserver(() => {
        if (tryMount()) obs.disconnect();
      });
      obs.observe(document.body, { childList: true, subtree: true });
      // 超时兜底
      setTimeout(() => obs.disconnect(), 15000);
    }
    // 定时刷新统计
    setInterval(refreshStats, 5000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
