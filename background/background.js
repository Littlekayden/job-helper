// background/background.js
// Boss Hunter 后台服务工作线程（Service Worker, MV3）
// 负责：默认配置初始化、投递统计持久化、消息路由、跨标签页状态广播。

export const DEFAULT_SETTINGS = {
  // 运行开关
  enabled: false,
  // 打招呼语（支持 {jobName} {companyName} {bossName} 占位符）
  greeting: '您好，我对这个岗位很感兴趣，方便详细沟通一下吗？我的相关经验比较匹配，期待您的回复！',
  // 每次会话最多打招呼数量
  maxGreetPerRun: 30,
  // 操作间隔（毫秒）——随机区间，规避频控
  minDelayMs: 3000,
  maxDelayMs: 6000,
  // 岗位过滤规则
  filter: {
    enabled: true,
    // 标题/岗位名包含任一关键词才打招呼（为空表示不限制）
    includeKeywords: [],
    // 标题/公司/岗位描述命中任一关键词则跳过
    excludeKeywords: ['外包', '驻场', '销售', '电话客服'],
    // 薪资下限（单位：K/月），0 表示不限制
    minSalary: 0,
    // 薪资上限（单位：K/月），0 表示不限制
    maxSalary: 0,
    // 公司规模黑名单关键词（如 “0-20人”）
    excludeCompanyScale: []
  }
};

const DEFAULT_STATS = {
  total: 0, // 累计打招呼
  today: 0, // 今日打招呼
  skipped: 0, // 累计跳过
  lastRunAt: null,
  dateKey: '' // 今日日期标记，用于跨天清零
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 安装/升级时写入默认配置（不覆盖用户已有配置）
chrome.runtime.onInstalled.addListener(async () => {
  const { settings, stats, greetedJobs } = await chrome.storage.local.get([
    'settings',
    'stats',
    'greetedJobs'
  ]);

  const merged = {};
  if (!settings) merged.settings = DEFAULT_SETTINGS;
  if (!stats) merged.stats = { ...DEFAULT_STATS, dateKey: todayKey() };
  if (!greetedJobs) merged.greetedJobs = []; // 已打招呼岗位指纹，用于去重

  if (Object.keys(merged).length) {
    await chrome.storage.local.set(merged);
  }
});

// 跨天清零今日计数
async function rolloverStatsIfNeeded() {
  const { stats } = await chrome.storage.local.get('stats');
  const s = stats || { ...DEFAULT_STATS };
  const key = todayKey();
  if (s.dateKey !== key) {
    s.today = 0;
    s.dateKey = key;
    await chrome.storage.local.set({ stats: s });
  }
  return s;
}

// 消息路由
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case 'GET_SETTINGS': {
          const { settings } = await chrome.storage.local.get('settings');
          sendResponse({ ok: true, settings: settings || DEFAULT_SETTINGS });
          break;
        }
        case 'SAVE_SETTINGS': {
          await chrome.storage.local.set({ settings: msg.settings });
          // 广播到所有 BOSS 直聘标签页，立即生效
          const tabs = await chrome.tabs.query({ url: '*://*.zhipin.com/*' });
          for (const t of tabs) {
            chrome.tabs.sendMessage(t.id, { type: 'SETTINGS_UPDATED', settings: msg.settings }).catch(() => {});
          }
          sendResponse({ ok: true });
          break;
        }
        case 'GET_STATS': {
          const s = await rolloverStatsIfNeeded();
          sendResponse({ ok: true, stats: s });
          break;
        }
        case 'RESET_STATS': {
          await chrome.storage.local.set({
            stats: { ...DEFAULT_STATS, dateKey: todayKey() },
            greetedJobs: []
          });
          sendResponse({ ok: true });
          break;
        }
        case 'RECORD_GREET': {
          const s = await rolloverStatsIfNeeded();
          s.total += 1;
          s.today += 1;
          s.lastRunAt = Date.now();
          // 记录指纹去重
          const { greetedJobs } = await chrome.storage.local.get('greetedJobs');
          const list = greetedJobs || [];
          if (msg.fingerprint && !list.includes(msg.fingerprint)) {
            list.push(msg.fingerprint);
            // 上限保护，避免无限增长
            if (list.length > 5000) list.splice(0, list.length - 5000);
          }
          await chrome.storage.local.set({ stats: s, greetedJobs: list });
          sendResponse({ ok: true, stats: s });
          break;
        }
        case 'RECORD_SKIP': {
          const s = await rolloverStatsIfNeeded();
          s.skipped += 1;
          await chrome.storage.local.set({ stats: s });
          sendResponse({ ok: true, stats: s });
          break;
        }
        case 'CHECK_GREETED': {
          const { greetedJobs } = await chrome.storage.local.get('greetedJobs');
          const list = greetedJobs || [];
          sendResponse({ ok: true, greeted: list.includes(msg.fingerprint) });
          break;
        }
        default:
          sendResponse({ ok: false, error: 'unknown message type' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e) });
    }
  })();
  return true; // 异步响应
});
