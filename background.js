// v104: 用户指定激进抢券参数 —— ①点击间隔 40ms→8ms(行216/324)；②开火时机统一 T-399ms(整点 startOffset 400→399，半点 300→399)；③开抢前 3s 强制刷新页面(整点/半点 start 函数加 setTimeout reload@-3000ms)，reload 后由 runScheduledClaim 自愈重新 arm+schedule(T-399ms 开火，避免 PREOPEN 期浪费点击)；④自愈 resched 也用 targetMs/399 而非 Date.now()/0。
// v103.3: 半点"16:31才弹出来/没干活"根因修复 —— ①后台tab不渲染券楼层 → startHalfClicking 一开始就 focusTabForUser 提到前台(原 focusTabForUser 在窗口结束才调，太晚)；focusTabForUser 加 notification 守卫(无标题不弹空通知)；②API 回包抓取正则收窄回 newBabelAwardCollection|receiveCoupon|grabCoupon|lingquan|drawCoupon，去掉误吞 feed 列表(client.action/api.m.jd.com) 的假"成功(0)"响应。
// v103: 修复半点「点了但无响应」—— __jdInvokeClaimHalf 新增 PREOPEN 过滤(即将开抢/待开抢等未开按钮 force 也不点)，只点 T=0 翻成的可领按钮；API 回包抓取正则放宽到 client.action；新增本地 watcher 实时盯盘通道(127.0.0.1:5173)。
// v100: 🔴 修复半点被 MV3 挂起 —— T-90s→T=0 改主动保活循环(短睡+周期executeScript)，防 service worker 空闲被杀(上轮16:30死在reload@-90s)
// 京东整点+半点领券助手 - background.js v103
// v102: 半点「自动识别去抢」—— __jdInvokeClaimHalf 不再只点满5减4，改为收集页面所有可领按钮，
//       满5减4优先(祖先查找6→10层)，其余可领券兜底全点；修复 16:30 非5-4券被漏(no-btn)的问题。
// v99.9: 刷新后识别下次时间的可靠性修复 —— discoverHalfSlots 改为两遍扫描(不要求时间紧挨状态词、状态词可扩展、
//       丢弃无状态信号的误匹配)；refreshHalfSlots 增加轮询等待 SPA 时间轴渲染(最多30s)，避免骨架屏漏设闹钟。
// v99.8: 修复 10:30「干瞪眼」—— T=0 自动把标签提到前台 + 弹通知（用户手动补点兜底）；
//   半点 claimLoop 遇 not-armed 自动 re-arm（防 SPA 重渲染丢失注入）；manifest 加 "tabs" 权限。
// v98: 🔴🔴 半点(hour.jd.com 10:30/16:30)重建，7/8 全面审计：
//   1. windowEnd 从未定义 → 半点函数一进主循环就 ReferenceError 崩溃（静默，无任何日志）
//   2. getOrCreateTab 用 includes 匹配 → plogin 登录跳转 URL 的 returnurl 里含 hour.jd.com
//      → 曾把登录页当目标页狂点。修：按 hostname+pathname 匹配并排除 plogin/passport
//   3. 半点无 T=0 准时刷新（6/26 11:30 唯一一次成功正是 reload-at-T0 之后）。修：setTimeout T=0 并发刷新
//   4. 半点锤击用过期坐标（同整点视口外落空 bug）。修：每 burst 前 in-page 对准+elementFromPoint 校验
//   5. 登录跳转检测：发现 plogin → 大声通知 + 打点，窗口内持续重试
// v97: 🔴🔴 三个致命修复（7/1 日志分析）：
//   1. CDP sendCommand 无超时 → 渲染器卡住时整轮挂起58分钟（banner-done@3505034ms, clicks=0）
//      修：每个 sendCommand 包 250ms 超时；超时则 detach+reattach 继续
//   2. 点击坐标失效 → 按钮在视口外（实测：按钮y=1142，视口高875，elementFromPoint=null）
//      几万次点击全部落空、0网络请求。修：每轮点击前 in-page scrollIntoView+重算坐标+elementFromPoint 校验
//   3. firstClickOff 在循环结束才记录（不是首击时刻）→ 日志时序全错。修：首击瞬间记录
// v96: 修复 CDP touchEnd（touchPoints 空数组）；debugger 一次 attach；webRequest 监听
// v95: 大banner: CDP 持续狂点；v94: CDP dispatchTouchEvent (isTrusted=true)

const VERSION = 'v133'; // v133: 修「reload 后闹钟永不自建」—— SW 启动时若一条 jd_ 闹钟都没有就重建；新增每日 10:20/16:20 定时 reload 载入磁盘代码。
// v132: 半点券认「超补好运券」系列(面额每天变,10/21 是满4减3,旧逻辑只认5-4→整轮clicks=0)；prescan 排除搜索/购物车等导航按钮(10/21 误把「搜索」当券按钮→hasButton 假阳性空跑)；卡片容器限长 600 字防巨型楼层误命中；认不出时返回 unknown 但 hasButton=true，绝不误杀整轮。v131 策略不变。
const TARGET_URL = 'pro.m.jd.com/mall/active/2BGmkjr2mbi81R4ozsAR1ragZcyh';
const HALF_TARGET_URL = 'hour.jd.com';

const START_HOUR = 8;
const END_HOUR = 23;
// 半点时段基线：京东标准半点券场(10:30/16:30) + 用户 9/04 指定的 11:00(同为半点逻辑、开 hour.jd.com 半点页)。
// 半点轮次不受「整点自动领券」开关管控(见 setupAlarms：jd_half_/jd_prescan_ 始终按 HALF_SLOTS 建闹钟)，故 11:00 半点页与 10:30/16:30 行为一致。
const HALF_SLOTS = ['10:30', '16:30', '11:00'];

// 默认目标（可在 options 页修改）
const DEFAULT_BANNER = '29-20';        // 整点大Banner：满29减20
const DEFAULT_COUPONS = ['10', '4-3']; // 整点小券：¥10、满4减3
const HALF_TARGET = '5-4';             // 半点优先券：满5减4

// 找不到标签时自动创建用的完整 URL
// v98: 必须带 /index.html?preventPV=1&forceCurrentView=1 —— 裸 URL 会 302 到 h5st.m.jd.com/.../error.html
const FULL_HOURLY_URL = 'https://pro.m.jd.com/mall/active/2BGmkjr2mbi81R4ozsAR1ragZcyh/index.html?preventPV=1&forceCurrentView=1';
const FULL_HALF_URL   = 'https://hour.jd.com/aggregationChannelPub/channel?channelType=mixSingleChannel&scene=single&args-smallHomeModuleId=36110&hgi-cpsIssueTouchPointId=BP-20250818-0001&hgi-cpsGrabTouchPointId=BP-20251223-0002&needLp=true';

// v113: 整点特价狙击 —— 京东外卖「天天半价」活动页，抢 ≤9.9 的特价商品。
// 与整点领券并行跑（独立 tab、独立活动页，互不干扰）。
// 可在 storage 覆盖：dealEnabled(设 false 关闭) / dealUrl / dealMaxPrice。
const DEAL_URL = 'pro.m.jd.com/mall/active/3F8kKo9k4wKvmQgtJJBzzr1JjdLH';
const FULL_DEAL_URL = 'https://pro.m.jd.com/mall/active/3F8kKo9k4wKvmQgtJJBzzr1JjdLH/index.html?preventPV=1&forceCurrentView=1';
const DEAL_MAX_PRICE = 9.9;

// ===== webRequest 监听器：捕获 JD API 请求 =====
// v96: 添加此监听器以捕获领券 API 请求（补全 injectNet 可能遗漏的请求）
let gWebReqs = [];
try {
  chrome.webRequest.onBeforeRequest.addListener((details) => {
    if (/api\.m\.jd\.com|uranus\.jd\.com|coupon/.test(details.url)) {
      gWebReqs.push({ url: details.url.slice(0, 200), method: details.method, ts: Date.now() });
      if (gWebReqs.length > 50) gWebReqs = gWebReqs.slice(-30);
    }
  }, { urls: ['https://*.jd.com/*', 'https://*.jd.cn/*'] });
  console.log('[京东领券] webRequest listener installed');
} catch(e) { console.log('[京东领券] webRequest listener failed:', e.message); }

// ===== v124→v130.1: 自愈热更新 ===== 轮询打包内 version.txt，磁盘版本新于运行版本即自动 runtime.reload()。
// ⚠️ 关键坑（用户 9/17 连续 3 次以为没修好）：SW 只能看到「已加载的包」，`fetch(chrome.runtime.getURL('version.txt'))`
// 返回的是内存里旧包，读不到你改的文件夹源文件 → 自检永远"相等"、永远不重载。必须从磁盘读才能感知增量。
// 故改用 chrome.runtime.getPackageDirectoryEntry 拿真实文件夹入口再读 version.txt（读不到则降级为不自愈，不误重载）。
let _jdSelfHealing = false;
function _jdReadDiskVersion() {
  return new Promise((resolve) => {
    try {
      chrome.runtime.getPackageDirectoryEntry((dir) => {
        if (!dir) return resolve(null);
        dir.getFile('version.txt', {}, (fe) => {
          if (!fe) return resolve(null);
          fe.file((f) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || '').trim());
            r.onerror = () => resolve(null);
            r.readAsText(f);
          }, () => resolve(null));
        }, () => resolve(null));
      });
    } catch (e) { resolve(null); }
  });
}
async function jdSelfHealCheck() {
  if (_jdSelfHealing) return false;
  try {
    const txt = await _jdReadDiskVersion();
    if (!txt) return false;            // 极少数环境读不到磁盘版本 → 不自愈，避免误重载
    if (txt !== VERSION) {
      _jdSelfHealing = true;
      console.log('[京东领券] 自愈：磁盘版本 ' + txt + ' ≠ 运行 ' + VERSION + ' → 自动重载');
      chrome.storage.local.set({ lastAlarm: { name: 'self-heal', at: new Date().toLocaleTimeString(), disk: txt, run: VERSION } }).catch(() => {});
      setTimeout(() => chrome.runtime.reload(), 200);
      return true;
    }
  } catch (e) {}
  return false;
}

// v127: 抄 MGTV 的自愈调度 —— SW 启动即查一次 + 每 15s 轮询。
// 之前 JD 只在「闹钟触发」时查版本(onAlarm 内)，SW 空闲时根本不查 → 磁盘版本改了也永远不重载，
// 所以用户每次都得手动重载、且 v126 一直没载入、心跳日志持续刷屏。15s 轮询与闹钟解耦，改完代码 15s 内自动热更。
jdSelfHealCheck().catch(() => {});
setInterval(() => jdSelfHealCheck().catch(() => {}), 15000);

// v133: SW 启动即「闹钟全丢」自修复 —— 这是 10/22、10/23 京东整天 0 条记录的真根因。
// 铁证：jd_heartbeat 是 1min 周期闹钟，每次触发都会写 storage.local.lastAlarm；
// 但 JD 的 LevelDB 000563.log mtime 停在 10/21 10:30，10/21-10/23 零写入 → 心跳闹钟早就不存在，SW 从未被唤醒。
// 成因：10/21 10:35 写完 v132 后被 jdSelfHealCheck 自动 chrome.runtime.reload()，reload 会清空 alarms，
// 而 setupAlarms 只在 onInstalled/onStartup 里调，扩展自己 reload 不算 onStartup → 闹钟永远没人重建。
// 修法：SW 每次启动，若一条 jd_ 闹钟都没有就重建（绝不在有闹钟时重建，避免自激循环）。
(async () => {
  try {
    const as0 = await chrome.alarms.getAll();
    if (as0.some(a => a.name.startsWith('jd_'))) return;
    const prev = (await chrome.storage.local.get('raceLog')).raceLog || [];
    prev.unshift({
      date: new Date().toISOString().slice(0, 10), round: '(boot)', type: 'self',
      outcome: 'boot:闹钟全丢已重建', detail: '原有闹钟数=' + as0.length + ' 当前VERSION=' + VERSION,
      events: [], clicks: 0, firstClickOff: null
    });
    await chrome.storage.local.set({ raceLog: prev.slice(0, 30) });
    await setupAlarms();
  } catch (e) {}
})();

// ===== 安装 / 启动 =====
chrome.runtime.onInstalled.addListener(() => {
  console.log(`[京东领券] ${VERSION} 已安装`);
  setupAlarms();
  jdSelfHealCheck().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  console.log(`[京东领券] ${VERSION} 启动`);
  setupAlarms();
  jdSelfHealCheck().catch(() => {});
});

// ===== 外部消息：允许从 JD 页面触发 reload（供 Claude MCP 自动热更新） =====
chrome.runtime.onMessageExternal.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'reload') {
    reply({ ok: true, version: VERSION });
    setTimeout(() => chrome.runtime.reload(), 50);
  } else if (msg && msg.type === 'selfcheck') {
    jdSelfHealCheck().then(r => reply({ ok: true, reloaded: r, version: VERSION }));
    return true; // 异步回包
  } else if (msg && msg.type === 'version') {
    reply({ ok: true, version: VERSION });
  } else if (msg && msg.type === 'getLog') {
    chrome.storage.local.get('raceLog').then(({raceLog}) => reply({ ok: true, log: (raceLog||[]).slice(0,10) }));
    return true;
  } else if (msg && msg.type === 'alarms') {
    chrome.alarms.getAll().then(as => reply({ ok: true, alarms: as.map(a => ({ n: a.name, at: new Date(a.scheduledTime).toLocaleTimeString() })) }));
    return true;
  } else if (msg && msg.type === 'scanSlots') {
    // v99.5: 手动触发自适应时段发现（诊断/验证）
    (async () => {
      const all = await chrome.tabs.query({});
      const ht = all.find(t => { try { return new URL(t.url || '').hostname.includes('hour.jd.com'); } catch (e) { return false; } });
      if (!ht) { reply({ ok: false, msg: 'no hour.jd.com tab' }); return; }
      const raw = await discoverHalfSlots(ht.id);
      await refreshHalfSlots(ht.id);
      const { halfSlots } = await chrome.storage.local.get('halfSlots');
      reply({ ok: true, raw, scheduled: halfSlots || [] });
    })();
    return true;
  } else if (msg && msg.type === 'getFlash') {
    chrome.storage.local.get('flashLog').then(d => reply({ ok: true, flashLog: d.flashLog || [] }));
    return true;
  } else if (msg && msg.type === 'getLive') {
    chrome.storage.local.get(['liveRound', 'lastAlarm']).then(d => reply({ ok: true, live: d.liveRound || null, lastAlarm: d.lastAlarm || null }));
    return true;
  } else if (msg && msg.type === 'setAlarms') {
    // v98.3: 外部开关闹钟（手动实验时先关，避免扩展抢占我的标签）
    alarmsEnabled = !!msg.enabled;
    if (alarmsEnabled) setupAlarms(); else chrome.alarms.clearAll();
    reply({ ok: true, alarmsEnabled });
  } else if (msg && msg.type === 'testClaim') {
    // v99: 验证扩展端 MAIN-world 直接调用领券 handler 能拿到真实服务器反馈
    (async () => {
      const all = await chrome.tabs.query({});
      const tab = all.find(t => { try { const u = new URL(t.url || ''); return u.hostname.includes('pro.m.jd.com') && u.pathname.includes('2BGmkjr2mbi81R4ozsAR1ragZcyh'); } catch (e) { return false; } });
      if (!tab) { reply({ ok: false, msg: 'no hourly tab open' }); return; }
      const armed = await armClaim(tab.id);
      const fired = await fireClaim(tab.id);
      await new Promise(r => setTimeout(r, 2500));
      const rr = await readClaimResp(tab.id);
      reply({ ok: true, armed, fired, resp: rr && rr.resp, count: rr && rr.count });
    })();
    return true;
  } else if (msg && msg.type === 'testHalf') {
    // v98: 半点流程干跑（immediate 模式，15s 窗口）—— 验证扫描/对准/日志全链路不崩
    (async () => {
      const tabId = await getOrCreateTab(HALF_TARGET_URL, FULL_HALF_URL, '半点领券');
      if (tabId != null) startHalfClicking(tabId, 0);
    })();
    reply({ ok: true, msg: 'testHalf started' });
  }
});

// ===== 点击扩展图标 = 立即测试整点 =====
chrome.action.onClicked.addListener(async (tab) => {
  const allTabs = await chrome.tabs.query({});
  const jdTab = allTabs.find(t => (t.url || '').includes(TARGET_URL) || (t.url || '').includes(HALF_TARGET_URL));
  if (!jdTab) {
    showNotification('⚠️ 未找到页面', '请先打开 pro.m.jd.com 或 hour.jd.com 领券页');
    return;
  }
  const tabId = jdTab.id;
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(jdTab.windowId, { focused: true });

  // dump DOM 帮助调试选择器
  const dump = await dumpDom(tabId);
  console.log('[京东领券] DOM DUMP:');
  dump.forEach(d => console.log(`  ${d.tag}.${d.cls} href=${d.href} ${d.w}×${d.h} "${d.text}"`));

  // 立即测试：按页面类型走对应逻辑
  if ((jdTab.url || '').includes(HALF_TARGET_URL)) startHalfClicking(tabId, 0);
  else grabHourly(tabId, 0);
});

// =====================================================================
// v99: 直接调用页面自身的领券 onClick 处理器（MAIN world）——绕过 CDP/合成点击
// 被 cactus 反爬过滤的问题。页面自己的 handler 会实时签名并发 newBabelAwardCollection，
// 拿到真实服务器反馈。等价于用户真人点击，只是编程触发（用户自己的账号/自己的券）。
// =====================================================================
// 注入一次：安装响应捕获 + 定义 window.__jdInvokeClaim()（找到最宽券按钮的祖先 onClick 并调用）
async function armClaim(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        if (!window.__jdClaimArmed) {
          window.__jdClaimArmed = true;
          window.__jdClaimResp = null; window.__jdClaimCount = 0;
          const grab = (u, txt) => { try { if (/AwardCollection|receiveCoupon|coupon\/?receive/i.test(String(u))) { window.__jdClaimResp = String(txt).slice(0, 300); } } catch (e) {} };
          const of = window.fetch;
          window.fetch = function (u, o) { const p = of.apply(this, arguments); try { p.then(r => r.clone().text()).then(t => grab(u, t)).catch(() => {}); } catch (e) {} return p; };
          const ox = XMLHttpRequest.prototype.open, sx = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return ox.apply(this, arguments); };
          XMLHttpRequest.prototype.send = function (b) { try { this.addEventListener('load', () => grab(this.__u, this.responseText)); } catch (e) {} return sx.apply(this, arguments); };
        }
        // force=true: 无视按钮文案（连"X:00再来"倒计时态也调用），抢在客户端翻牌(~T+450ms)之前
        // 于 T=0 直接触发领券 handler。服务器 T=0 开放，客户端翻牌有延迟 —— 提前打服务器决定。
        window.__jdInvokeClaim = function (force) {
          const DONE = /已抢光|已领取|已抢完|已结束|明日再来|去使用|敬请期待/, TIME = /\d{1,2}:\d{2}/, CLAIM = /立即领取|立即抢券|马上抢|立刻抢|领取/;
          let btn = null, maxw = 0;
          for (const b of document.querySelectorAll('[data-type="coupon_text_button"]')) {
            const t = (b.textContent || '').replace(/\s+/g, '');
            if (!t || DONE.test(t)) continue;                       // 永远跳过已抢光/已领取
            if (!force && (TIME.test(t) || !CLAIM.test(t))) continue; // 非 force：只认真正可领
            const r = b.getBoundingClientRect(); if (r.width > maxw) { maxw = r.width; btn = b; }
          }
          if (!btn) return 'no-btn';
          let el = btn, handler = null, host = null;
          for (let d = 0; d < 12 && el; d++) { const k = Object.keys(el).find(x => x.startsWith('__reactEventHandlers$') || x.startsWith('__reactProps$')); if (k && el[k] && typeof el[k].onClick === 'function') { handler = el[k].onClick; host = el; break; } el = el.parentElement; }
          if (!handler) return 'no-handler';
          try { handler({ stopPropagation() {}, preventDefault() {}, persist() {}, currentTarget: host, target: btn, nativeEvent: {}, type: 'click', bubbles: true }); window.__jdClaimCount++; return 'invoked'; }
          catch (e) { return 'err:' + (e.message || '').slice(0, 40); }
        };
        // v99.7: 页面内高频狂发 —— 每 ~8ms 调一次 handler（无 SW↔页面往返延迟），
        // 密集覆盖 T=0 开放瞬间(整点窗口仅~54ms，120ms 间隔会落进空档漏掉)。
        // 拿到终态(成功/售罄)即停；上限 120 次防跑飞。
        window.__jdRapidClaim = function (durationMs) {
          if (window.__jdRapidRunning) return 'already';
          window.__jdRapidRunning = true; window.__jdRapidFires = 0; window.__jdRapidDone = false;
          const TERM = /领取成功|恭喜|成功领取|已抢完|已抢光|已领取过|不可重复|已领取|已使用/;
          const end = Date.now() + durationMs;
          const tick = () => {
            const r = window.__jdClaimResp || '';
            if (Date.now() > end || TERM.test(r) || window.__jdRapidFires >= 120) { window.__jdRapidRunning = false; window.__jdRapidDone = true; return; }
            try { window.__jdInvokeClaim(true); window.__jdRapidFires++; } catch (e) {}
            if (r && !TERM.test(r)) window.__jdClaimResp = null;  // 清掉"未开始/请稍后"，继续狂发
            setTimeout(tick, 8);
          };
          tick();
          return 'rapid-started';
        };
        // v101: 页面自调度狂发 —— 由页面自己的定时器在 (targetMs - startOffset) 精确开火，
        // 不依赖 service worker 在 T=0 是否还活着/准时（SW 挂起也照打）。记录首次开火偏移供验证。
        window.__jdScheduleRapid = function (targetMs, startOffsetMs, durationMs) {
          if (window.__jdSchedRunning) return 'already-scheduled';
          window.__jdSchedRunning = true; window.__jdRapidFires = 0; window.__jdRapidDone = false; window.__jdFirstFireOff = null;
          const TERM = /领取成功|恭喜|成功领取|抢券成功|已抢完|已抢光|已领取过|不可重复|已领取|已使用/;
          const end = targetMs + durationMs;
          const invoke = window.__jdInvokeClaimHalf || window.__jdInvokeClaim;
          const tick = () => {
            const r = window.__jdClaimResp || '';
            if (Date.now() > end || TERM.test(r) || window.__jdRapidFires >= 400) { window.__jdSchedRunning = false; window.__jdRapidDone = true; return; }
            try { let s = invoke(true); if (s === 'no-btn' && window.__jdSelectSlot && (Date.now() - (window.__jdLastSlotSel || 0) > 800)) { window.__jdLastSlotSel = Date.now(); try { window.__jdSelectSlot(true); } catch (e2) {} s = invoke(true); } if (String(s).startsWith('invoked')) { window.__jdRapidFires++; if (window.__jdFirstFireOff == null) window.__jdFirstFireOff = Date.now() - targetMs; } } catch (e) {}
            if (r && !TERM.test(r)) window.__jdClaimResp = null;
            setTimeout(tick, 8);  // v101.1: 40ms(~25/s) 防冻结渲染；仍远密于旧 250ms
          };
          const delay = Math.max(0, (targetMs - startOffsetMs) - Date.now());
          setTimeout(tick, delay);
          return 'scheduled@fire-in-' + delay + 'ms';
        };
        return 'armed';
      }
    });
    return r?.[0]?.result || null;
  } catch (e) { return 'arm-exc:' + e.message.slice(0, 40); }
}
// 触发一次领券（force=无视翻牌，抢在客户端翻牌前打服务器）
async function fireClaim(tabId, force) {
  try { const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [!!force], func: (f) => (window.__jdInvokeClaim ? window.__jdInvokeClaim(f) : 'not-armed') }); return r?.[0]?.result || null; } catch (e) { return 'fire-exc:' + e.message.slice(0, 40); }
}
// 读取捕获到的服务器响应
async function readClaimResp(tabId) {
  try { const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => ({ resp: window.__jdClaimResp || null, count: window.__jdClaimCount || 0 }) }); return r?.[0]?.result || null; } catch (e) { return null; }
}

// v99.2: 半点(hour.jd.com)专用领券 —— 该页用 TOUCH 事件(onTouchStart/End)而非 onClick，
// 且目标是 满5减4「超补好运券」。窗口很长(实测16:30过点1小时仍"正在抢券中")，可从容反复调用。
async function armClaimHalf(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        if (!window.__jdClaimArmed) {
          window.__jdClaimArmed = true; window.__jdClaimResp = null; window.__jdClaimCount = 0;
          const grab = (u, txt) => { try { if (/newBabelAwardCollection|receiveCoupon|coupon\/receive|grabCoupon|lingquan|drawCoupon/i.test(String(u))) window.__jdClaimResp = String(txt).slice(0, 400); } catch (e) {} };
          const of = window.fetch; window.fetch = function (u, o) { const p = of.apply(this, arguments); try { p.then(r => r.clone().text()).then(t => grab(u, t)).catch(() => {}); } catch (e) {} return p; };
          const ox = XMLHttpRequest.prototype.open, sx = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; return ox.apply(this, arguments); };
          XMLHttpRequest.prototype.send = function (b) { try { this.addEventListener('load', () => grab(this.__u, this.responseText)); } catch (e) {} return sx.apply(this, arguments); };
        }
        window.__jdInvokeClaimHalf = function (force) {
          const DONE = /已抢光|已领取|已抢完|已结束|明日再来|去使用|已使用|敬请期待/;
          const PREOPEN = /即将开抢|待开抢|即将开始|即将开场|预热中|未开始|距.*开抢|即将开放|敬请期待|明日|明天/;
          const CLAIM = /立即领取|立即抢券|马上抢|立刻抢|领取|抢券|去抢|立即去抢|一键领取/;
          // v104: 🔴 类名无关的按钮查找 —— JD 改版后券按钮在 .grab-coup 容器里，不再是 coupon_text_button。
          // 17:30 日志证明券「立即抢券」在场但 fires=0(旧选择器找不到)。改为：扫多选择器里"短文案=可领词"的叶子按钮。
          const sels = '[data-type="coupon_text_button"],.coupon-button-text,.coupon-button-wrap,.coupon-bu,.grab-coup div,.grab-coup span,[class*="grab"] div,[class*="grab"] span';
          const cand = [];
          const seen = new Set();
          for (const b of document.querySelectorAll(sels)) {
            const t = (b.textContent || '').replace(/\s+/g, '');
            if (!t || t.length > 12 || DONE.test(t) || PREOPEN.test(t)) continue;  // 只要短文案的按钮本体
            if (!CLAIM.test(t)) continue;  // 必须是可领文案(立即抢券/立即领取/…)，未开/无按钮则 no-btn 继续等
            if (seen.has(b)) continue; seen.add(b);
            cand.push(b);
          }
          let btn = null;
          // 优先 满5减4/满2/超补好运/好运券：向上最多 10 层容器匹配
          for (const b of cand) {
            let p = b, ok = false;
            for (let i = 0; i < 10 && p; i++) { if (/满5减4|满5可用|满2可用|超补好运|好运券/.test((p.textContent || '').replace(/\s+/g, ''))) { ok = true; break; } p = p.parentElement; }
            if (ok) { btn = b; break; }
          }
          if (!btn && cand.length) btn = cand[0];  // 兜底：任何可领券
          if (!btn) return 'no-btn';
          // 向上找带 onClick 或 onTouchEnd/onTouchStart 的祖先
          let el = btn, host = null, kind = null, hobj = null;
          for (let d = 0; d < 12 && el; d++) {
            const k = Object.keys(el).find(x => x.startsWith('__reactEventHandlers$') || x.startsWith('__reactProps$'));
            if (k && el[k]) { const o = el[k]; if (typeof o.onClick === 'function') { host = el; kind = 'click'; hobj = o; break; } if (typeof o.onTouchEnd === 'function' || typeof o.onTouchStart === 'function') { host = el; kind = 'touch'; hobj = o; break; } }
            el = el.parentElement;
          }
          if (!host) return 'no-handler';
          const r = btn.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
          const mkTouch = () => ({ identifier: 0, target: btn, clientX: cx, clientY: cy, pageX: cx, pageY: cy, screenX: cx, screenY: cy, radiusX: 5, radiusY: 5, rotationAngle: 0, force: 1 });
          const tp = [mkTouch()];
          // v99.4: 富事件对象 —— touches/targetTouches/changedTouches 都塞入触点(连 touchend 也塞，
          // 避免 handler 读 e.touches[0].x 时 undefined 报错)；顶层也带坐标；nativeEvent 指回自身。
          const mkEv = (type) => { const ev = { type, stopPropagation() {}, preventDefault() {}, persist() {}, currentTarget: host, target: btn, bubbles: true, cancelable: true, clientX: cx, clientY: cy, pageX: cx, pageY: cy, screenX: cx, screenY: cy, touches: tp, targetTouches: tp, changedTouches: tp, timeStamp: 0, detail: 1, button: 0, buttons: 1 }; ev.nativeEvent = ev; return ev; };
          try {
            if (kind === 'click') { hobj.onClick(mkEv('click')); }
            else { if (hobj.onTouchStart) hobj.onTouchStart(mkEv('touchstart')); if (hobj.onTouchEnd) hobj.onTouchEnd(mkEv('touchend')); }
            window.__jdClaimCount++; return 'invoked:' + kind;
          } catch (e) { return 'err:' + (e.message || '').slice(0, 110); }
        };
        // v102: 切换时段小 tab —— 时间轴有 [已结束|正在抢券中|待开抢] 三个 tab，券随选中的 tab 变。
        // 用户要求："切到最近的下一场"。选 正在抢券中(有则)，否则最近的 待开抢；调用其祖先 onClick。
        window.__jdSelectSlot = function (preferActive) {
          const nodes = [];
          for (const el of document.querySelectorAll('div')) {
            if (el.children.length) continue;
            const x = (el.textContent || '').replace(/\s+/g, '');
            if (x === '正在抢券中' || x === '待开抢') nodes.push({ el, state: x });
          }
          if (!nodes.length) return 'no-slot';
          let pick = preferActive ? nodes.find(n => n.state === '正在抢券中') : null;
          if (!pick) pick = nodes.find(n => n.state === '待开抢') || nodes.find(n => n.state === '正在抢券中');
          if (!pick) return 'no-target';
          let el = pick.el, host = null, hobj = null, kind = null;
          for (let d = 0; d < 8 && el; d++) { const k = Object.keys(el).find(z => z.startsWith('__reactEventHandlers$') || z.startsWith('__reactProps$')); if (k && el[k]) { const o = el[k]; if (typeof o.onClick === 'function') { host = el; hobj = o; kind = 'click'; break; } if (typeof o.onTouchEnd === 'function') { host = el; hobj = o; kind = 'touch'; break; } } el = el.parentElement; }
          if (!host) return 'slot-no-handler';
          try {
            const r = host.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
            const tp = [{ identifier: 0, target: host, clientX: cx, clientY: cy, pageX: cx, pageY: cy, radiusX: 5, radiusY: 5, force: 1 }];
            const ev = { type: kind === 'click' ? 'click' : 'touchend', stopPropagation() {}, preventDefault() {}, persist() {}, currentTarget: host, target: host, bubbles: true, cancelable: true, clientX: cx, clientY: cy, touches: [], targetTouches: [], changedTouches: tp }; ev.nativeEvent = ev;
            if (kind === 'click') hobj.onClick(ev); else { if (hobj.onTouchStart) hobj.onTouchStart(Object.assign({}, ev, { type: 'touchstart', touches: tp, targetTouches: tp })); hobj.onTouchEnd(ev); }
            return 'switched:' + pick.state;
          } catch (e) { return 'slot-err:' + (e.message || '').slice(0, 30); }
        };
        // v100: 半点也用页面内高频狂发（每~10ms），防 5-4 快速售罄时 250ms 间隔漏掉。
        window.__jdRapidClaimHalf = function (durationMs) {
          if (window.__jdRapidRunning) return 'already';
          window.__jdRapidRunning = true; window.__jdRapidFires = 0; window.__jdRapidDone = false;
          const TERM = /领取成功|恭喜|成功领取|抢券成功|已抢完|已抢光|已领取过|不可重复|已领取|已使用/;
          const end = Date.now() + durationMs;
          const tick = () => {
            const r = window.__jdClaimResp || '';
            if (Date.now() > end || TERM.test(r) || window.__jdRapidFires >= 400) { window.__jdRapidRunning = false; window.__jdRapidDone = true; return; }
            try { const s = window.__jdInvokeClaimHalf(true); if (String(s).startsWith('invoked')) window.__jdRapidFires++; } catch (e) {}
            if (r && !TERM.test(r)) window.__jdClaimResp = null;  // 清掉"未开始/请稍后"，继续
            setTimeout(tick, 10);
          };
          tick();
          return 'rapid-started';
        };
        // v101: 页面自调度狂发（半点 touch 版）—— 页面定时器精确在 T-startOffset 开火，不依赖 SW。
        window.__jdScheduleRapid = function (targetMs, startOffsetMs, durationMs) {
          if (window.__jdSchedRunning) return 'already-scheduled';
          window.__jdSchedRunning = true; window.__jdRapidFires = 0; window.__jdRapidDone = false; window.__jdFirstFireOff = null;
          const TERM = /领取成功|恭喜|成功领取|抢券成功|已抢完|已抢光|已领取过|不可重复|已领取|已使用/;
          const end = targetMs + durationMs;
          const invoke = window.__jdInvokeClaimHalf || window.__jdInvokeClaim;
          const tick = () => {
            const r = window.__jdClaimResp || '';
            if (Date.now() > end || TERM.test(r) || window.__jdRapidFires >= 400) { window.__jdSchedRunning = false; window.__jdRapidDone = true; return; }
            try { let s = invoke(true); if (s === 'no-btn' && window.__jdSelectSlot && (Date.now() - (window.__jdLastSlotSel || 0) > 800)) { window.__jdLastSlotSel = Date.now(); try { window.__jdSelectSlot(true); } catch (e2) {} s = invoke(true); } if (String(s).startsWith('invoked')) { window.__jdRapidFires++; if (window.__jdFirstFireOff == null) window.__jdFirstFireOff = Date.now() - targetMs; } } catch (e) {}
            if (r && !TERM.test(r)) window.__jdClaimResp = null;
            setTimeout(tick, 8);  // v101.1: 40ms(~25/s) 防冻结渲染（半点 touch handler 较重）
          };
          const delay = Math.max(0, (targetMs - startOffsetMs) - Date.now());
          setTimeout(tick, delay);
          return 'scheduled@fire-in-' + delay + 'ms';
        };
        return 'armed';
      }
    });
    return r?.[0]?.result || null;
  } catch (e) { return 'arm-exc:' + e.message.slice(0, 40); }
}
async function fireClaimHalf(tabId, force) {
  try { const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [!!force], func: (f) => (window.__jdInvokeClaimHalf ? window.__jdInvokeClaimHalf(f) : 'not-armed') }); return r?.[0]?.result || null; } catch (e) { return 'fire-exc:' + e.message.slice(0, 40); }
}
// v100: 半点领券循环 —— 页面内高频狂发(每~10ms)；SW 侧轮询结果并在页面重渲染丢失注入时重新 arm。
async function claimLoopHalf(tabId, stamp, durationMs) {
  let armed = await armClaimHalf(tabId);
  stamp('half-claim-armed:' + armed);
  let started = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [durationMs], func: (d) => (window.__jdRapidClaimHalf ? window.__jdRapidClaimHalf(d) : 'not-armed') });
  stamp('half-rapid:' + (started?.[0]?.result));
  const end = Date.now() + durationMs + 2000;
  let lastResp = '';
  while (Date.now() < end) {
    const rr = await readClaimResp(tabId);
    let done = false, fires = 0, running = false;
    try { const st = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => ({ done: !!window.__jdRapidDone, fires: window.__jdRapidFires || 0, running: !!window.__jdRapidRunning, armed: !!window.__jdInvokeClaimHalf }) }); const o = st?.[0]?.result || {}; done = o.done; fires = o.fires; running = o.running; if (!o.armed) done = true; } catch (e) {}
    if (rr && rr.resp && rr.resp !== lastResp) {
      lastResp = rr.resp;
      if (/领取成功|恭喜|成功领取|抢券成功/.test(rr.resp)) { stamp('CLAIM-RESP:' + rr.resp); stamp('🎉WON-half fires=' + fires); return { won: true, resp: rr.resp, fires }; }
      if (/已抢完|已抢光|已领取过|不可重复|已领取|已使用/.test(rr.resp)) { stamp('CLAIM-RESP:' + rr.resp); stamp('sold-out/dup fires=' + fires); return { won: false, resp: rr.resp, fires }; }
    }
    // 页面重渲染导致注入丢失（rapid 停了但没终态）→ 重新 arm + 重启狂发
    if (done && !lastResp) {
      armed = await armClaimHalf(tabId);
      const rs = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [Math.max(2000, end - Date.now())], func: (d) => (window.__jdRapidClaimHalf ? window.__jdRapidClaimHalf(d) : 'not-armed') });
      if ((rs?.[0]?.result) === 'not-armed') { stamp('half-rearm-fail'); break; }
      stamp('half-rearm+rapid');
    }
    await sleep(200);
  }
  const rr = await readClaimResp(tabId);
  return { won: false, resp: rr && rr.resp, fires: 0 };
}
// 领券循环：arm 一次，然后从现在起每 ~150ms 触发，直到拿到成功/售罄反馈或超时
async function claimLoop(tabId, stamp, durationMs) {
  const armed = await armClaim(tabId);
  stamp('claim-armed:' + armed);
  // v99.7: 启动页面内高频狂发(每~8ms，无 SW↔页面往返)，密集覆盖 T=0 开放瞬间。
  // SW 侧只负责轮询结果，不再自己每120ms发一次(太慢会漏掉~54ms窗口)。
  const started = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', args: [durationMs], func: (d) => (window.__jdRapidClaim ? window.__jdRapidClaim(d) : 'not-armed') });
  stamp('rapid:' + (started?.[0]?.result));
  const end = Date.now() + durationMs + 2000;
  let lastResp = '';
  while (Date.now() < end) {
    const rr = await readClaimResp(tabId);
    let done = false, fires = 0;
    try { const st = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => ({ done: !!window.__jdRapidDone, fires: window.__jdRapidFires || 0 }) }); done = st?.[0]?.result?.done; fires = st?.[0]?.result?.fires || 0; } catch (e) {}
    if (rr && rr.resp && rr.resp !== lastResp) {
      lastResp = rr.resp;
      if (/领取成功|恭喜|成功领取/.test(rr.resp)) { stamp('CLAIM-RESP:' + rr.resp); stamp('🎉WON fires=' + fires); return { won: true, resp: rr.resp, fires }; }
      if (/已抢完|已抢光|已领取过|不可重复|已领取|已使用/.test(rr.resp)) { stamp('CLAIM-RESP:' + rr.resp); stamp('sold-out/dup fires=' + fires); return { won: false, resp: rr.resp, fires }; }
    }
    if (done) { stamp('rapid-done fires=' + fires); return { won: false, resp: rr && rr.resp, fires }; }
    await sleep(150);
  }
  const rr = await readClaimResp(tabId);
  return { won: false, resp: rr && rr.resp, fires: 0 };
}

// v101: 统一"页面自调度狂发"运行器 —— SW 提前 arm + 让页面自己的定时器在 T-startOffset 精确开火
// （SW 挂起/迟缓也不影响开火时刻），SW 只负责轮询结果 + 记录真实首击偏移 first-fire@Xms 供验证。
// v103: 本地盯盘通道 —— 把每轮「有无真响应」POST 到 127.0.0.1:5173(由 claim-watcher 接收落盘)。
// 失败静默(本地服务未起/沙箱网络隔离都不影响扩展本身)。
async function watchReport(kind, targetMs, res) {
  try {
    const payload = JSON.stringify({
      t: Date.now(), kind,
      round: new Date(targetMs).toTimeString().slice(0, 8),
      won: !!res.won, resp: res.resp || null, fires: res.fires || 0,
      firstFireOff: (res.firstFireOff == null ? null : res.firstFireOff)
    });
    fetch('http://127.0.0.1:5173/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }).catch(() => {});
  } catch (e) {}
}

// v109: 可信点击核心 —— 走 CDP Input.dispatchMouseEvent(isTrusted=true) 真实驱动页面领券 onClick，
// 替代"直接调 window.__jdInvokeClaim(非可信事件被反爬当空气)"的回退 bug(实测几十轮全 D2 一次没中)。
// getXY(): 每次 burst 前重新扫描+滚到券按钮并返回视口中心 {x,y}(T-1s/T0 刷新会重置滚动，必须重取)。
async function trustedClaim(tabId, stamp, targetMs, startOffset, durationMs, isHalf, getXY) {
  const armed = isHalf ? await armClaimHalf(tabId) : await armClaim(tabId);
  stamp((isHalf ? 'half-' : '') + 'trusted-armed:' + armed);
  // v110.1: 注入点击记录器(之前定义了却从未调用 —— 导致无法确证 CDP 可信点击是否以 trusted click 抵达页面)。
  // 幂等(带 __jdClickRec 守卫)，在开火前注入，hNetSummary/readClickRecorder 才能给出真实 trusted 计数。
  // v114: 每轮开火前清空归因日志与页面记录，保证 ext/human 计数只统计本轮。
  __dispatchLog = [];
  try { await injectClickRecorder(tabId, true); } catch (e) { stamp('clickrec-inject-fail'); }
  // 确保网络拦截器已注入(捕获领券响应用于判断 成功/已抢完) —— 幂等(带 wrapper 守卫，不重复包裹)
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
      window.__jdNet = window.__jdNet || []; window.__jdReqs = window.__jdReqs || [];
      if (window.__jdFetchWrap) return;
      const pushResp = (t) => { try { if (t && t.length < 800) window.__jdNet.push(t.slice(0, 600)); } catch (e) {} };
      const of = window.fetch;
      window.fetch = function (u, o) { return of.apply(this, arguments).then(r => { r.clone().text().then(t => pushResp(t)).catch(() => {}); return r; }); };
      const op = XMLHttpRequest.prototype.open, sd = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (m, u) { this._jdUrl = u; return op.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function (b) { this.addEventListener('load', () => pushResp(this.responseText)); return sd.apply(this, arguments); };
      window.__jdFetchWrap = true;
    }});
  } catch (e) { stamp('net-inject-fail'); }
  // v111: 读网络响应 + 页面终态(按钮翻成"去使用"/成功 toast)。
  // 只靠网络响应停火不可靠 —— 16:30 实测 __jdNet 一条领券响应都没抓到，导致抢中后仍狂点 60s。
  const readState = async () => {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
        const all = (window.__jdNet || []).concat((window.__jdReqs || []).map(x => x.body || ''), [window.__jdClaimResp || '']);
        const hit = all.find(s => s && /newBabelAwardCollection|领取成功|成功领取|抢券成功|已抢完|已抢光|已领取过|不可重复|已领取|已使用|本时段优惠券/i.test(s));
        let doneCount = 0;
        try {
          for (const b of document.querySelectorAll('[data-type="coupon_text_button"],.coupon-button-text,[class*="coupon"]')) {
            if (/去使用|去试用|立即使用|已领取/.test(b.textContent || '')) doneCount++;
          }
        } catch (e) {}
        let toast = '';
        try {
          for (const el of document.querySelectorAll('[class*="toast"],[class*="Toast"],[class*="tips"],[class*="dialog"]')) {
            const t = (el.textContent || '').trim();
            if (t && t.length < 60 && /领取成功|恭喜|成功领取|抢券成功/.test(t)) { toast = t; break; }
          }
        } catch (e) {}
        return { resp: hit || null, doneCount, toast };
      }});
      return r?.[0]?.result || { resp: null, doneCount: 0, toast: '' };
    } catch (e) { return { resp: null, doneCount: 0, toast: '' }; }
  };
  const until = targetMs + durationMs + 3000;
  let lastResp = '', firstLogged = false, fires = 0, firstFireOff = null;
  // v122: 目标留痕。9/10 10:30 那轮 fires=224 却零服务器响应，日志里连「点了什么」都没有，
  // 无法区分「坐标被遮挡 hit=false」「点的是预点档非按钮」「券面文案已变导致找不到目标」。
  // 只在目标特征变化时记一行（每轮都记会把关键日志冲掉）。
  let lastXyKey = '';
  // v111: URL 逃逸守卫 —— 抢中后页面常跳到下单/使用页，此时坐标不变继续点会打到新页面同位置(可能是"提交订单")。
  let baseUrl = '';
  try { const t0 = await chrome.tabs.get(tabId); baseUrl = (t0.url || '').split('?')[0]; } catch (e) {}
  const urlEscaped = async () => {
    try { const t = await chrome.tabs.get(tabId); const u = (t.url || '').split('?')[0]; return (baseUrl && u && u !== baseUrl) ? u : ''; }
    catch (e) { return ''; }
  };
  await sleepUntil(targetMs - startOffset);
  // v114: 补注入 —— 整点在 T-8s 有 reload，会把上面那次注入的监听器随文档销毁(localStorage 里的记录仍在)。
  // reset=false，只重挂监听，不清空本轮已记录的内容。
  try { await injectClickRecorder(tabId, false); } catch (e) {}
  // v111: 开火前基线 —— 页面上可能本来就有别的"去使用"券，只有数量增加才算这轮抢中
  const doneBase = (await readState()).doneCount;
  try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (e) {}
  // v112: 解除后台 tab 节流 —— 整点在后台跑，Chrome 把定时器节流到 ≥1s，页面倒计时不翻牌
  // (这正是 v108 当初加 T0 reload 的原因，但 reload 让首火延迟到 +4s，代价更大)。
  // 改用 CDP 强制页面生命周期为 active：后台也能正常跑定时器、准时翻牌，且无需切前台。
  try { await chrome.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' }); stamp((isHalf ? 'half-' : '') + 'lifecycle:active'); }
  catch (e) { stamp((isHalf ? 'half-' : '') + 'lifecycle-fail'); }
  while (Date.now() < until) {
    const xy = getXY ? (await getXY()) : null;
    if (xy && xy.x != null) {
      const key = xy.tier + '|hit=' + xy.hit + '|' + xy.text + '|' + xy.x + ',' + xy.y;
      if (key !== lastXyKey) { lastXyKey = key; stamp('xy:' + key + ' card=' + xy.card + ' ' + xy.w + 'x' + xy.h); }
      const before = fires;
      try { fires += await cdpClickLoop(tabId, xy.x, xy.y, 250, 90, null, urlEscaped); }
      catch (e) { /* cdpClickLoop 内部已 detach/reattach 自愈 */ }
      if (!firstLogged && fires > before) { firstLogged = true; firstFireOff = Date.now() - targetMs; stamp('first-fire@' + firstFireOff + 'ms'); }
    } else {
      // 没找到目标时也记：why 说明到底是 no-elem / all-done / no-target-card / no-btn-shape
      const key = '空:' + ((xy && xy.why) || 'null');
      if (key !== lastXyKey) { lastXyKey = key; stamp('xy-' + key); }
      await sleep(120);
    }
    // v111: URL 逃逸 —— 已离开活动页(多半是抢中后跳下单/使用页)，立即停火。绝不能在新页面同坐标继续点(可能是"提交订单")
    const esc = await urlEscaped();
    if (esc) {
      // v119: 跳转 ≠ 抢中。9/03 10:30 连点 115 次后页面跳到 hour.jd.com/msstore/index（活动首页），
      // 旧逻辑直接判 ✅领取成功，实际没券 —— 属于误报。
      // 只有页面终态确认（去使用增加 / 成功 toast）或跳到明确的成功页，才算真中。
      let st2 = {};
      try { st2 = await readState(); } catch (e) {}
      const pageWon = !!(st2.toast || st2.doneCount > doneBase);
      const urlWon = /order|success|usecoupon|couponuse|getcoupon|mycoupon|领取成功/i.test(esc);
      const jumpWon = pageWon || urlWon;
      stamp('ESCAPED-URL:' + esc.slice(0, 80));
      stamp((jumpWon ? '🎉WON(jumped)' : '⚠️意外跳转(未确认中奖)') + ' fires=' + fires + (pageWon ? ' [页面终态确认]' : ' [无终态证据]'));
      watchReport(isHalf ? 'half' : 'hour', targetMs, { won: jumpWon, resp: (jumpWon ? 'jump:' : '意外跳转:') + esc, fires, firstFireOff });
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      return { won: jumpWon, resp: (jumpWon ? 'jump:' : '意外跳转(未确认):') + esc, fires, firstFireOff, jumped: esc };
    }
    const st = await readState();
    // v111: 页面终态优先于网络响应 —— 按钮翻成"去使用"(较基线增加)或出现成功 toast 即判定抢中，立即停火
    if (st.toast || st.doneCount > doneBase) {
      const why = st.toast ? ('toast:' + st.toast) : ('btn去使用+' + (st.doneCount - doneBase));
      stamp('PAGE-WON:' + why); stamp('🎉WON fires=' + fires);
      watchReport(isHalf ? 'half' : 'hour', targetMs, { won: true, resp: st.resp || why, fires, firstFireOff });
      try { await chrome.debugger.detach({ tabId }); } catch (_) {}
      return { won: true, resp: st.resp || why, fires, firstFireOff };
    }
    const resp = st.resp;
    if (resp && resp !== lastResp) {
      lastResp = resp;
      if (/领取成功|恭喜|成功领取|抢券成功/.test(resp)) { stamp('CLAIM-RESP:' + resp.slice(0, 80)); stamp('🎉WON fires=' + fires); watchReport(isHalf ? 'half' : 'hour', targetMs, { won: true, resp, fires, firstFireOff }); try { await chrome.debugger.detach({ tabId }); } catch (_) {} return { won: true, resp, fires, firstFireOff }; }
      if (/已抢完|已抢光|已领取过|不可重复|已领取|已使用|本时段优惠券/.test(resp)) { stamp('CLAIM-RESP:' + resp.slice(0, 80)); stamp('sold-out/dup fires=' + fires); watchReport(isHalf ? 'half' : 'hour', targetMs, { won: false, resp, fires, firstFireOff }); try { await chrome.debugger.detach({ tabId }); } catch (_) {} return { won: false, resp, fires, firstFireOff }; }
    }
    await sleep(20);
  }
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  const resp = (await readState()).resp;
  watchReport(isHalf ? 'half' : 'hour', targetMs, { won: false, resp, fires, firstFireOff });
  return { won: false, resp, fires, firstFireOff };
}

// v109: 半点统一走可信点击(trustedClaim)；getXY 由调用方传入(扫描+滚到券按钮返回视口中心)。
async function runScheduledClaim(tabId, stamp, targetMs, startOffset, durationMs, isHalf, getXY) {
  return trustedClaim(tabId, stamp, targetMs, startOffset, durationMs, isHalf, getXY);
}

// v108: 整点后台自点击 —— 不切前台，由 SW 侧直接驱动狂发。
// 后台 tab 的 setTimeout 会被 Chrome 节流到 ≥1s，页面内 __jdScheduleRapid 的 8ms 循环失效；
// 故 SW 每 ~8ms 用 executeScript 调一次页面 handler（executeScript 不受页面定时器节流影响），
// 持续覆盖到点开放窗口。页面只需 JS 仍运行(后台不杀 JS，只杀定时器)即可。
// v109: 整点统一走可信点击(trustedClaim)；getXY 由 grabHourly 传入(重新扫描+滚到券按钮返回视口中心)。
async function runBackgroundClaim(tabId, stamp, targetMs, startOffset, durationMs, isHalf, getXY) {
  return trustedClaim(tabId, stamp, targetMs, startOffset, durationMs, isHalf, getXY);
}

// =====================================================================
// 整点抓取 v61（早刷新 + 轮询等按钮 + 全程保活 + 计时日志）
// 实测(2026-06-22)：该 SPA 刷新→领取按钮出现要 10~60s 且极不稳定，所以绝不能 T-6s 才刷新
//   （上一版固定等 3.5s，到点时页面常还没加载好 → 在空/旧页面上狂点 → 几乎必丢）。
// 策略：闹钟 T-95s 触发 → T-90s 刷新 → 轮询直到领取按钮真正出现(最多到 T-6s) →
//        滚到按钮并持续重测坐标/保活 SW → T-50ms 起在原地狂点到 T+2s（按钮到点会就地变可领）。
//        每轮把 reload/button-ready/首击偏移/结果 记到 console + storage.raceLog 供复盘改进。
// targetBanner/targetCoupons 仅用于排序优先级；商品列表的「券丨满4减3」无领取按钮，天然被排除。
// targetTime: 整点目标时间戳(ms)；传 0 = 立即测试
// =====================================================================
async function grabHourly(tabId, targetTime) {
  const data = await chrome.storage.local.get(['targetBanner', 'targetCoupons', 'targetCoupon']);
  const prefPats = [data.targetBanner || DEFAULT_BANNER]
    .concat(Array.isArray(data.targetCoupons) ? data.targetCoupons : (data.targetCoupon ? [data.targetCoupon] : DEFAULT_COUPONS))
    .map(s => String(s).trim()).filter(Boolean);
  const immediate = !targetTime || targetTime <= 0;

  const log = { date: targetTime ? new Date(targetTime).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10), round: targetTime ? new Date(targetTime).toTimeString().slice(0, 8) : 'test', events: [] };
  // v98: 每次打点即时落盘到 storage.liveRound —— 之前轮次中途崩溃会连日志都不留（12:00 轮全无痕迹）
  const stamp = (l) => {
    const o = targetTime ? Math.round(Date.now() - targetTime) : 0;
    log.events.push(`${l}@${o}ms`); console.log(`[整点] ${l} @${o}ms`);
    chrome.storage.local.set({ liveRound: { round: log.round, type: 'hour', at: Date.now(), events: log.events } }).catch(() => {});
  };
  stamp('start');
  gWebReqs = []; // v96: 清空 webRequest 捕获的请求日志
  let couponTabId = tabId; // 函数级变量，warm-up 和 Phase 1/2 共享
  try { await chrome.debugger.detach({ tabId }); } catch (e) {}

  let primary = null, scrolled = false, secondary = null;
  const refreshPrimary = async () => {
    // v110: 用原始扫描结果作兜底 —— sortClaims 按 prefPats 过滤(且排除 DONE 态"今日已抢光")后可能为空，
    // 但 DONE 态 banner 在 T=0 会翻成"立即领取"，必须保留其坐标作 hammer 目标，否则整轮 0 点击(no-primary)。
    const raw = await scanHourClaims(tabId);
    const claims = sortClaims(raw, prefPats);
    const chosen = (claims && claims.length) ? claims : raw;
    if (!chosen.length) return 0;
    if (!scrolled) { await scrollToY(tabId, chosen[0].absoluteY); await sleep(120); scrolled = true; }
    const freshRaw = await scanHourClaims(tabId);
    const fresh = sortClaims(freshRaw, prefPats);
    const freshChosen = (fresh && fresh.length) ? fresh : freshRaw;
    primary = freshChosen.length ? (nearestClaim(freshChosen, chosen[0].absoluteY) || freshChosen[0]) : chosen[0];
    return (freshChosen.length || chosen.length);
  };

  if (!immediate) {
    await sleepUntil(targetTime - 90000);
    stamp(await healOrReload(tabId, TARGET_URL, FULL_HOURLY_URL));
    // v112: 单 tab 刷新（不打开重复 Tab）—— 只在 T-8s 刷新一次，之后页面保持静止。
    // 【为什么删掉 reload@-1000ms / reload@T0】racelog 实测：整点 26 轮 0 中，首火中位数 +4007ms
    // (最差 +5958ms)，因为 T0 刷新让页面在开抢瞬间重新加载，CDP 必须干等页面 ready 才能点击，
    // 券早已秒光；且 T-1s 刷新导致 T-648ms 抓坐标时页面仍在加载，坐标落在旧 DOM 上。
    // 对照半点(不做 T0 刷新)：4 轮 4 中，首火 -40ms / 398ms / 507ms / -41ms。
    // 结论：提前刷新 + T0 页面静止 = 能在 T0 前后 100ms 内开火。整点对齐该模式。
    if (!immediate) {
      setTimeout(() => { try { chrome.tabs.reload(couponTabId); stamp('reload@-8000ms'); } catch (e) {} }, Math.max(0, targetTime - Date.now() - 8000));
    }
    // v108: 整点改为后台自点击，不切前台(避免打断用户)。后台 tab 的 setTimeout 会被 Chrome 节流到≥1s，
    // 因此点击改由 SW 侧驱动(runBackgroundClaim 每~8ms 调一次 handler)，页面倒计时是否翻牌不再影响抢券。
    // 仅保留后台 reload + 扫描(均不依赖前台)；页面 JS 仍运行，只是定时器被节流。
    let ready = false;
    while (Date.now() < targetTime - 6000) {
      await sleep(900);
      if ((await scanHourClaims(tabId)).length) { ready = true; stamp('button-ready'); break; }
    }
    if (!ready) stamp('button-NOT-ready');
    await scrollLazyLoad(tabId);
    await refreshPrimary();
    stamp(primary ? `primary "${(primary.amount || primary.text).slice(0, 16)}"` : 'no-primary');
    // Inject net interceptor early (at T-84s). Captures URL+response for API discovery.
    try {
      await chrome.scripting.executeScript({ target: { tabId }, func: () => {
        window.__jdNet = []; window.__jdReqs = [];
        const pushResp = (url, t) => { try { if (t && t.length < 600) window.__jdNet.push(t.slice(0, 400)); } catch(e){} };
        const pushReq  = (url, body) => { try { window.__jdReqs.push({ url: (url||'').slice(0,200), body: (body||'').slice(0,200), ts: Date.now() }); } catch(e){} };
        const origFetch = window.fetch;
        window.fetch = function(url, opts) {
          pushReq(url, opts && opts.body);
          return origFetch.apply(this, arguments).then(r => { r.clone().text().then(t => pushResp(url, t)).catch(()=>{}); return r; });
        };
        const op = XMLHttpRequest.prototype.open, sd = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(m, url) { this._jdUrl = url; return op.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function(body) {
          pushReq(this._jdUrl, body);
          this.addEventListener('load', () => pushResp(this._jdUrl, this.responseText));
          return sd.apply(this, arguments);
        };
      }});
    } catch(e) { stamp('net-inject-fail'); }

    // v98.6: 只用 1 个标签页（用户确认现在只抢 29-20 banner，无需第二张券的 Tab2）。
    // 不再 chrome.tabs.create —— banner 就地翻牌，同一 tab 即可，避免弹出多余标签页。
    couponTabId = tabId;

    // Keep-alive: refresh banner coords, pre-warm debugger at T-2s, then break at T-800ms（v97: 锤击提前到 ~T-750ms 开始）
    let lastTxt = null, warmed = false;
    while (Date.now() < targetTime - 800) {
      if (!warmed && targetTime - Date.now() < 2000) {
        try { await chrome.debugger.attach({ tabId }, '1.3'); await chrome.debugger.detach({ tabId }); warmed = true; stamp('warm'); } catch(e) {}
      }
      await refreshPrimary();
      const txt = primary ? (primary.text || primary.amount || '') : '(none)';
      if (txt !== lastTxt) { stamp('btn=' + txt); lastTxt = txt; }
      const remaining = (targetTime - 800) - Date.now();
      await sleep(Math.min(300, Math.max(0, remaining)));
    }
    // v112: 唯一一次刷新已在 T-90s 处预约于 T-8s(见 reload@-8000ms)；T0 前后不再刷新，保证页面静止可立即开火。
    // Find secondary (4-3/10) coords - 异步执行（不影响 Phase 1 准时开始）
    const findSecondary = (async () => {
      const latestClaims = sortClaims(await scanHourClaims(tabId), prefPats);
      secondary = latestClaims.find(c => !bgMatch(prefPats[0], (c.amount||'')+(c.text||''))) || null;
      if (secondary) stamp(`sec="${(secondary.amount||secondary.text||'').slice(0,14)}"(${secondary.x},${secondary.y})`);
      else stamp('no-secondary');
    })();
  } else {
    await scrollLazyLoad(tabId);
    await refreshPrimary();
  }

  stamp('hammer-start');
  let totalClicks = 0, clicks2 = 0, firstClickOff = null, firstClickOff2 = null;

  // ── Phase 1: v99 直接调用页面自身领券 handler（真实服务器领取）──────────
  // 弃用 CDP/合成点击（被 cactus 反爬过滤，从不触发服务器）。改为从 T-500ms 起
  // 反复调用页面 onClick handler，实时签名发 newBabelAwardCollection，拿真实反馈。
  // 提前到 T-500ms 开始（用户要求：可能有其它延迟），翻牌前返回 no-claimable-btn，
  // 翻牌瞬间即真实领取。
  // v101: 页面自调度狂发 —— 现在(≈T-800ms，warm-up 刚结束)就 arm + 让页面定时器在 T-400ms 精确开火。
  // 开火时刻由页面自己的 setTimeout 决定，SW 此后挂起/迟缓都不影响(修复"有时 T+400ms 才开始点")。
  let claimResult = null;
  // v109: 每次 burst 重新扫描+滚到券按钮返回视口中心(避开 T-1s/T0 刷新后坐标过期落空)
  const hourGetXY = async () => {
    // v110: 同 refreshPrimary —— sortClaims 过滤后为空时回退原始扫描(含 DONE 态 banner)，T=0 翻牌后重扫自然拿到可领坐标
    const raw = await scanHourClaims(tabId);
    const claims = sortClaims(raw, prefPats);
    const chosen = (claims && claims.length) ? claims : raw;
    if (!chosen.length) return null;
    await scrollToY(tabId, chosen[0].absoluteY);
    await sleep(120);
    const freshRaw = await scanHourClaims(tabId);
    const fresh = sortClaims(freshRaw, prefPats);
    const freshChosen = (fresh && fresh.length) ? fresh : freshRaw;
    const c = freshChosen.length ? (nearestClaim(freshChosen, chosen[0].absoluteY) || freshChosen[0]) : chosen[0];
    return (c && c.x != null) ? { x: c.x, y: c.y } : null;
  };
  // v108: 整点后台自点击 —— 不再 T-3s 刷新(会清空页面上下文，且后台模式不需要翻牌)；
  // 改由 SW 直接驱动狂发(runBackgroundClaim)，每~8ms 调一次页面 handler(不受后台定时器节流影响)。
  claimResult = await runBackgroundClaim(couponTabId, stamp, immediate ? Date.now() : targetTime, immediate ? 0 : 399, immediate ? 8000 : 20000, false, hourGetXY);
  totalClicks = claimResult.fires || 0;
  firstClickOff = (claimResult.firstFireOff != null) ? claimResult.firstFireOff : firstClickOff;

  // v99: claimLoop 已拿到服务器权威结果 —— 直接据此收尾，跳过后续所有(已弃用的)CDP扫描/点击
  {
    let outcome;
    if (claimResult.won) outcome = '✅领取成功|' + String(claimResult.resp || '').slice(0, 60);
    else if (claimResult.resp) outcome = '❌' + String(claimResult.resp).slice(0, 70);
    else outcome = '🟡无服务器响应(未出现可领?) fires=' + totalClicks;
    stamp('outcome:' + outcome);
    log.outcome = outcome; log.clicks = totalClicks; log.clicks2 = 0;
    log.firstClickOff = firstClickOff; log.firstClickOff2 = null;
    // 🔔 v99.8: 没抢到 → 再提醒一次 + 提前台（整点券 300ms 售罄，手动补点通常来不及，但告知结果）
    if (!claimResult.won) {
      showNotification('⏰ 整点结果', `${log.round} 扩展未抢到（${claimResult.resp ? '已售罄' : '无响应'}），请查看页面`);
    }
    try {
      const prev = (await chrome.storage.local.get('raceLog')).raceLog || [];
      prev.unshift(log);
      await chrome.storage.local.set({ raceLog: prev.slice(0, 30) });
    } catch (e) {}
    showNotification(immediate ? '🧪 整点测试' : '整点结果', outcome.slice(0, 80));
    // v130: 不再自动下载文件——避免 Chrome「下载前询问保存位置」时反复弹"保存"框卡住(用户 9/16 17:31 投诉"保存两次且停在保存页待确认")。
    // 数据已写入 chrome.storage.local.raceLog(上面 set)，options 页内联可见；需文件时由 options「导出」按钮手动触发。
    return;
  }

  // ── v98.1: 翻牌监视（与 Phase 2 并发跑在 Tab1 上）──────────────────────
  // 7/1 18:00 日志证明：banner 按钮 ~T+3.5s 在原地从"X:00再来"翻成"立即领取"，
  // 但旧锤击 T+2.5s 就停了，翻牌后从未有过"验证命中的可信点击"。这里持续对准+狂点到 T+12s。
  const flipWatch = (!immediate && primary) ? (async () => {
    try {
      const end = targetTime + 12000;
      let attached = false, flipStamped = false;
      while (Date.now() < end) {
        const p = await alignClaimTarget(tabId, [], 'wide');
        const txt = (p && p.text) || '';
        if (p && /立即领取|马上抢|立刻抢/.test(txt) && !/\d{1,2}:\d{2}/.test(txt)) {
          if (!attached) { try { await chrome.debugger.attach({ tabId }, '1.3'); attached = true; } catch(e) {} }
          if (!flipStamped) { flipStamped = true; stamp(`flip!(${p.x},${p.y}) hit=${p.hit} "${txt}"`); }
          totalClicks += await cdpClickLoop(tabId, p.x, p.y, 600, 250);
        } else if (/已领取|已抢光|已抢完|去使用/.test(txt)) {
          stamp('flip-end:' + txt.slice(0, 10));
          break;
        } else {
          await sleep(250);
        }
      }
      if (attached) { try { await chrome.debugger.detach({ tabId }); } catch(e) {} }
    } catch(e) { stamp('flipwatch-err:' + String(e && e.message || e).slice(0, 30)); }
  })() : Promise.resolve();
  // ── Tab2: Phase 2 使用第二个标签页 ──
  // couponTabId 在 warm-up 阶段已创建（函数级变量，共享）
  // T=0 时 reload → 页面以正确时间状态加载，券按钮直接显示"立即领取"
  if (!immediate) {
    const scanTabId = couponTabId;
    // v97: Tab2 已在 T=0 由 setTimeout 并发 reload（见 Phase 1 前），此处无需再等/再刷
    let netInjected = false;
    const injectNet = async () => {
      try {
        await chrome.scripting.executeScript({ target: { tabId: scanTabId }, func: () => {
          if (window.__jdNetInjected) return;
          window.__jdNetInjected = true;
          window.__jdNet = []; window.__jdReqs = [];
          const pushResp = (url, t) => { try { if (t && t.length < 600) window.__jdNet.push(t.slice(0, 400)); } catch(e){} };
          const pushReq  = (url, body) => { try { window.__jdReqs.push({ url: (url||'').slice(0,200), body: (body||'').slice(0,200), ts: Date.now() }); } catch(e){} };
          const origFetch = window.fetch;
          window.fetch = function(url, opts) {
            pushReq(url, opts && opts.body);
            return origFetch.apply(this, arguments).then(r => { r.clone().text().then(t => pushResp(url, t)).catch(()=>{}); return r; });
          };
          const op = XMLHttpRequest.prototype.open, sd = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function(m, url) { this._jdUrl = url; return op.apply(this, arguments); };
          XMLHttpRequest.prototype.send = function(body) {
            pushReq(this._jdUrl, body);
            this.addEventListener('load', () => pushResp(this._jdUrl, this.responseText));
            return sd.apply(this, arguments);
          };
        }});
        netInjected = true;
      } catch(e) {}
    };

    const CLAIMABLE = /立即领取|马上抢|开抢|立刻抢|领取/;
    const HAS_TIME = /\d{1,2}:\d{2}/;
    let cx = null, cy = null;
    const couponWindowEnd = targetTime + 40000;
    let lastReloadTs = Date.now() - 5000;  // 初始化为过去5秒
    let scanLogDone = false;

    // ⚠️ 日志显示：每~500ms刷新一次 → 页面永远加载不完 → 永远找不到按钮。修：只等不刷。
    const MIN_WAIT = 8000;  // 前8秒只扫描不刷新，留时间给SPA完全渲染
    while (Date.now() < couponWindowEnd && cx === null) {
      await sleep(500);
      if (!netInjected) await injectNet();
      try {
        // 先扫 scanTabId（Tab2），找不到则回退到 tabId（Tab1 + 弹窗/覆盖层）
        let fresh = sortClaims(await scanHourClaims(scanTabId), prefPats);
        if (fresh.length === 0 && scanTabId !== tabId) {
          const fallback = sortClaims(await scanHourClaims(tabId), prefPats);
          if (fallback.length > 0) fresh = fallback;
        }
        if (!scanLogDone) {
          scanLogDone = true;
          const summary = fresh.slice(0, 5).map(c => '"' + (c.text||'').slice(0,10) + '"').join(',');
          stamp('p2-scan:[' + summary + ']@' + Math.round(Date.now()-targetTime) + 'ms');
        }
        // log 每个按钮被过滤的原因
        var whyFiltered = [];
        fresh.forEach(function(c) {
          var why = '';
          if (!CLAIMABLE.test(c.text || '')) why += '!CLAIMABLE ';
          if (HAS_TIME.test(c.text || '')) why += 'HAS_TIME ';
          if (bgMatch(prefPats[0], (c.amount||'')+(c.text||''))) why += 'BANNER ';
          if (why) whyFiltered.push({ text: (c.text||'').slice(0,10), amount: (c.amount||'').slice(0,10), why: why.trim(), x:c.x, y:c.y });
          else whyFiltered.push({ text: (c.text||'').slice(0,10), amount: (c.amount||'').slice(0,10), why: 'OK', x:c.x, y:c.y });
        });
        if (whyFiltered.length > 0) stamp('p2-reason:' + JSON.stringify(whyFiltered.slice(0,5)));
        // v118: 临近开抢(T-3s 起)不再等按钮文案翻成"可领"——按券面特征锚定目标券直接点(卡片锚点预点)。
        // 实测 9/02 客户端翻牌延迟 26.4s，等它纯属自损；服务器 T=0 即开放，提前开撸能抢在翻牌前打中。
        const nearT = Date.now() >= targetTime - 3000;
        const isTargetCoupon = (c) => bgMatch(prefPats[0], (c.amount||'')+(c.text||'')) || /满5减4|5-4|5减4|满5可用|超补好运|好运券/.test((c.amount||'')+(c.text||''));
        let found = fresh.find(c =>
          CLAIMABLE.test(c.text || '') &&
          !HAS_TIME.test(c.text || '') &&
          !bgMatch(prefPats[0], (c.amount||'')+(c.text||''))
        );
        if (!found && nearT && fresh.length) {
          const fb = fresh.find(c => isTargetCoupon(c) && !bgMatch(prefPats[0], (c.amount||'')+(c.text||'')));
          if (fb) { found = fb; stamp('hour-prefire:目标券未翻牌即开点@' + Math.round(Date.now()-targetTime) + 'ms'); }
        }
        if (found) {
          cx = found.x; cy = found.y;
          stamp('coupon-ready:"' + (found.amount||found.text||'').slice(0,14) + '"(' + cx + ',' + cy + ')@' + Math.round(Date.now()-targetTime) + 'ms');
          break;
        }
      } catch(e) {}
      // 前 MIN_WAIT ms 只等不刷，避免打断页面加载
      const elapsed = Date.now() - targetTime;
      if (elapsed > MIN_WAIT && Date.now() - lastReloadTs > 8000 && Date.now() < couponWindowEnd - 5000) {
        stamp('p2-reload@' + Math.round(Date.now() - targetTime) + 'ms');
        try { await chrome.tabs.reload(scanTabId); } catch(e) {}
        netInjected = false; scanLogDone = false; lastReloadTs = Date.now();
        await sleep(1000);
      }
    }

    if (cx !== null) {
      // v97: 每轮 burst 前重新对准（scrollIntoView+重算坐标+elementFromPoint 校验），
      // 点击 800ms 后再对准。修复：坐标过期/按钮在视口外导致所有点击落空。
      const couponEnd = targetTime + 50000;
      let alignFails = 0, alignLogged = false;
      try { await chrome.debugger.attach({ tabId: scanTabId }, '1.3'); } catch(e) {}
      while (Date.now() < couponEnd) {
        try {
          const pt = await alignClaimTarget(scanTabId, [], false);
          if (!pt) {
            alignFails++;
            if (alignFails >= 10) { stamp('coupon-gone@' + Math.round(Date.now()-targetTime) + 'ms'); break; }
            await sleep(300);
            continue;
          }
          alignFails = 0;
          if (!alignLogged) { alignLogged = true; stamp(`coupon-align (${pt.x},${pt.y}) hit=${pt.hit} "${pt.text}"`); }
          if (firstClickOff2 === null) firstClickOff2 = Math.round(Date.now() - targetTime);
          clicks2 += await cdpClickLoop(scanTabId, pt.x, pt.y, 800, 100);
        } catch(e) { stamp('ce2:' + e.message.slice(0, 24)); await sleep(200); }
      }
      try { await chrome.debugger.detach({ tabId: scanTabId }); } catch(e) {}
      stamp(`coupon-done clicks2=${clicks2} first@${firstClickOff2}ms`);
    } else {
      stamp('coupon-not-found');
    }
  }
  await flipWatch;  // v98.1: 确保翻牌监视的点击/打点计入本轮
  stamp(`hammer-done banner=${totalClicks} coupon=${clicks2}`);

  // Read network responses + request URLs captured during hammer
  // 修复：从 BOTH tabId 和 scanTabId 读取（banner API 在 tabId，coupon API 可能在 scanTabId）
  await sleep(300); // let in-flight XHR responses settle
  let netOutcome = '';
  let allNets = [], allReqs = [];
  for (const tid of [tabId, couponTabId !== tabId ? couponTabId : null]) {
    if (!tid) continue;
    try {
      const rr = await chrome.scripting.executeScript({ target: { tabId: tid }, func: () => ({ net: window.__jdNet || [], reqs: window.__jdReqs || [] }) });
      const { net: nets, reqs } = rr?.[0]?.result || { net: [], reqs: [] };
      allNets = allNets.concat(nets);
      allReqs = allReqs.concat(reqs);
    } catch(e) {}
  }
  try {
    stamp(`net-responses:${allNets.length} reqs:${allReqs.length} web:${gWebReqs.length}`);
    // Log first 3 request URLs from each source
    allReqs.slice(0, 3).forEach((r, i) => stamp(`req${i}:${r.url.slice(0, 80)}`));
    gWebReqs.slice(0, 3).forEach((r, i) => stamp(`web${i}:${r.url.slice(0, 80)}`));
    const won  = allNets.find(r => /领取成功|恭喜/.test(r));
    const sold = allNets.find(r => /已抢完|已抢光|本时段优惠券已抢完/.test(r));
    const fail = allNets.find(r => /失败|稍后|retry|errorCode/.test(r));
    if (won)       { netOutcome = '✅net:领取成功'; stamp('NET-WON:' + won.slice(0, 60)); }
    else if (sold) { netOutcome = '❌net:已抢完';   stamp('NET-SOLD:' + sold.slice(0, 60)); }
    else if (fail) { netOutcome = '⚠️net:失败';     stamp('NET-FAIL:' + fail.slice(0, 60)); }
    else if (allNets.length) { stamp('net-raw:' + allNets[0].slice(0, 80)); }
    // v98.3: 点击记录器读数 —— click 事件到底有没有抵达页面
    try {
      const rec = await readClickRecorder(tabId);
      if (rec) stamp('clickrec:' + JSON.stringify(rec).slice(0, 160));
    } catch (e2) {}
    // v98.1: 打点所有唯一 functionId（原来只打前3条URL，领券API可能藏在后面）
    if (gWebReqs.length) {
      const fids = [...new Set(gWebReqs.map(r => {
        const m = r.url.match(/functionId=([^&]+)/); return m ? m[1] : r.url.replace(/^https:\/\//, '').slice(0, 40);
      }))];
      stamp('web-fids(' + gWebReqs.length + '):' + fids.slice(0, 15).join(','));
      const claimish = gWebReqs.filter(r => /coupon|Coupon|receive|Receive|draw|Draw|lq|getCoupon/.test(r.url));
      claimish.slice(0, 3).forEach((r, i) => stamp('claim-api' + i + ':' + r.url.slice(0, 100)));
    }
  } catch(e) { stamp('net-read-fail'); }

  let domOutcome = await readOutcome(tabId);
  const outcome = netOutcome || domOutcome;
  stamp('outcome:' + outcome);
  log.outcome = outcome; log.clicks = totalClicks; log.clicks2 = clicks2;
  log.firstClickOff = firstClickOff; log.firstClickOff2 = firstClickOff2;
  try {
    const prev = (await chrome.storage.local.get('raceLog')).raceLog || [];
    prev.unshift(log);
    await chrome.storage.local.set({ raceLog: prev.slice(0, 30) });
  } catch (e) {}
  console.log('[整点] 📋 本轮日志:', JSON.stringify(log));
  showNotification(immediate ? '🧪 整点测试' : '整点结果', `${outcome}｜banner:${totalClicks} coupon:${clicks2}｜首击@${firstClickOff}ms`);
  // v130: 不再自动下载(见 VERSION 注释)；raceLog 已写入 storage，options 页「导出」按钮手动触发。
}

// 驱动侧金额匹配（仅用于排序，不注入页面）
function bgMatch(pat, text) {
  if (!text) return false;
  if (/[^0-9\-_]/.test(pat)) { // 含汉字/符号的优先词(如 "20元金券"/"金券") → 直接包含
    if (text.includes(pat)) return true;
    if (!/[-_]/.test(pat)) return false;
  }
  const parts = String(pat).split(/[-_]/).map(s => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const X = parts[0], Y = parts[1];
    return new RegExp('(?<![0-9])满?\\s*' + X + '[^0-9]{1,6}' + Y + '(?![0-9])').test(text)
      || (new RegExp('满\\s*' + X + '(?![0-9])').test(text) && new RegExp('[¥￥减]\\s*' + Y + '(?![0-9])').test(text));
  }
  const n = parts[0];
  return new RegExp('[¥￥]\\s*' + n + '(?![0-9.])|(?<![0-9.满])' + n + '\\s*元').test(text);
}
function sortClaims(claims, prefPats) {
  const score = (c) => {
    const t = (c.amount || '') + ' ' + (c.text || '');
    for (let i = 0; i < prefPats.length; i++) if (bgMatch(prefPats[i], t)) return i;
    return 999;
  };
  return claims.slice().sort((a, b) => (score(a) - score(b)) || (a.absoluteY - b.absoluteY));
}
function nearestClaim(claims, absY) {
  return claims.slice().sort((a, b) => Math.abs(a.absoluteY - absY) - Math.abs(b.absoluteY - absY))[0];
}

// ===== CDP Hybrid Click: 真实触摸+鼠标事件（isTrusted=true） =====
// JD 移动页使用 touch event handlers，但 executeScript 的 dispatchEvent 产生 isTrusted=false
// 被 React SyntheticEvent 忽略。CDP Input.dispatchTouchEvent 发送真实的 OS 级触摸事件。
// ===== CDP 点击：正确触发 JD 的 touch/click 处理器 =====
// 关键修复：
//   1. touchEnd 的 touchPoints 必须为空数组（规范）
//   2. 每个 touchStart 用唯一 id，touchEnd 不匹配 id
//   3. 添加 pointerDown/pointerUp（JD 可能用 PointerEvent）
//   4. debugger 由调用方管理（attach/detach 一次，不是每次点击）
// v97: 所有 CDP 命令包超时 —— 渲染器卡住时 sendCommand 永不 resolve，曾导致整轮挂起58分钟
function cdpCmd(tabId, method, params, timeoutMs = 250) {
  return Promise.race([
    chrome.debugger.sendCommand({ tabId }, method, params),
    new Promise((_, rej) => setTimeout(() => rej(new Error('cdp-timeout')), timeoutMs))
  ]);
}

// v98.2: 纯鼠标点击，完全复刻人工点击路径。
// 证据(审计 jd-racelog.json)：所有轮次自动点击从未触发领券 API（net-responses:0 / web 仅监控类请求），
// 但用户人工鼠标点击能触发 newBabelAwardCollection。原因：touchStart+touchEnd+mouse 的组合会让
// 浏览器不合成标准 click 事件（touch 与 mouse 互相抵消）。改回纯 mouseMoved→mousePressed→mouseReleased，
// 浏览器会像人工一样合成 click，命中 JD 的 click 处理器。
// v98.4: 7/8 19:00 数据 —— click 记录器证实 isTrusted=true 且坐标命中，仍 0 次 API 调用。
// 排除 navigator.webdriver（已确认 false，无自动化指纹）。下一个假设：CDP 单次瞬移+0ms按下释放
// 与真实点击的"移动轨迹+按下-释放停留"差异过大，可能被行为层面的风控吃掉。
// 改为：随机起点→3~5 段移动轨迹（每段带像素级抖动+8~20ms停顿）→按下→60~120ms停留→
// 释放时坐标再抖动1px。牺牲点击频率换取真实感（此前"快"从未成功过，值得一试"慢而真"）。
// v114: 归因日志 —— 记录扩展每次 mousePressed 的绝对时刻，用于与页面观测到的 mousedown 比对，
// 判定"这一下到底是扩展点的还是人手点的"(CDP 事件 isTrusted 也是 true，无法靠 isTrusted 区分)。
let __dispatchLog = [];
async function cdpTouchClick(tabId, x, y) {
  // v115: 改用 TOUCH 事件模拟真手指点。京东 m 站(pro.m.jd.com / hour.jd.com)的"抢/领"按钮
  // 多绑 touchstart/touchend 或 Taro/Zepto 的 tap 手势，只认 pointerType:'touch'；
  // 原先的 Input.dispatchMouseEvent 产生 pointerType:'mouse'，handler 收不到 → 点击无效
  // (表现为狂点几十下、唯独人手点那下才中)。touchStart+touchEnd 浏览器还会自动合成 click 事件，
  // 因此同时覆盖 touch 手势按钮与 React onClick 按钮，比鼠标事件更兼容。频率保持最快，不改 cps。
  const jx = () => Math.round(Math.random() * 2 - 1);          // 落点 ±1px 微抖，更像真人
  const tx = x + jx(), ty = y + jx();
  if (__dispatchLog.length < 4000) __dispatchLog.push(Date.now());
  await cdpCmd(tabId, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: tx, y: ty }] });
  await sleep(30 + Math.random() * 50);                         // 手指短停留
  await cdpCmd(tabId, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// 持续狂点（debugger 需在调用前已 attach）。v97: 超时/出错不再 break 放弃 —— detach+reattach 后继续
// v111: guard —— 可选中断回调(返回真值即停)。用于"页面已跳走"时立刻收手，
// 否则本批剩余点击会以相同屏幕坐标打在新页面上(下单页该位置可能是"提交订单")。
async function cdpClickLoop(tabId, x, y, durationMs, clicksPerSec = 80, onFirstClick = null, guard = null) {
  let n = 0, consecFail = 0;
  const end = Date.now() + durationMs;
  const delay = Math.max(3, Math.round(1000 / clicksPerSec));
  while (Date.now() < end) {
    if (guard && n > 0 && n % 8 === 0) { try { if (await guard()) break; } catch (e) {} }
    try {
      await cdpTouchClick(tabId, x, y);
      n++;
      if (n === 1 && onFirstClick) onFirstClick();
      consecFail = 0;
    } catch(e) {
      consecFail++;
      try { await chrome.debugger.detach({ tabId }); } catch(e2) {}
      try { await chrome.debugger.attach({ tabId }, '1.3'); } catch(e2) {}
      if (consecFail >= 8) break;  // 渲染器彻底死了才放弃
    }
    await sleep(delay);
  }
  return n;
}

// v97: 点击前对准 —— in-page 找到可领按钮、scrollIntoView 居中、返回视口内新坐标并用
// elementFromPoint 校验命中。曾发现按钮 y=1142 而视口高 875 → 所有点击落在视口外。
async function alignClaimTarget(tabId, excludeTexts, anyMode) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: (excl, anyMode) => {
        const DONE = /已抢光|已领取|已抢完|已结束|明日再来|去使用|去试用|敬请期待/;
        const HAS_TIME = /\d{1,2}:\d{2}/;
        const CLAIMABLE = /立即领取|马上抢|立刻抢|领取/;
        const btns = [...document.querySelectorAll('[data-type="coupon_text_button"]')];
        // anyMode: true=第一个按钮（banner锤击预对准）; 'wide'=第一个宽按钮（banner翻牌监视）; false=小券
        const tgt = anyMode === 'wide'
          ? (btns.find(b => b.getBoundingClientRect().width >= 250) || btns[0])
          : anyMode ? btns[0] : btns.find(b => {
          const t = (b.textContent || '').trim().replace(/\s+/g, '');
          if (!t || DONE.test(t) || HAS_TIME.test(t) || !CLAIMABLE.test(t) || (excl || []).includes(t)) return false;
          return b.getBoundingClientRect().width < 250;  // 排除大banner按钮（宽~342），只留小券
        });
        if (!tgt) return null;
        tgt.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = tgt.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        const el = document.elementFromPoint(x, y);
        const hit = !!(el && (tgt === el || tgt.contains(el) || el.contains(tgt)));
        return { x, y, hit, text: (tgt.textContent || '').trim().replace(/\s+/g, '').slice(0, 12) };
      },
      args: [excludeTexts || [], !!anyMode]
    });
    return res?.[0]?.result || null;
  } catch(e) { return null; }
}


// ===== 驱动层：调用页面内函数 =====
async function scrollLazyLoad(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, func: pageScrollLazyLoad });
  } catch (e) { console.log('[京东领券] 滚动懒加载失败:', e.message); }
}
async function scrollToY(tabId, y) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (yy) => window.scrollTo({ top: yy - window.innerHeight / 2, behavior: 'instant' }),
      args: [y]
    });
  } catch (e) {}
}
async function locateBanner(tabId, pat) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageLocateBanner, args: [pat] });
    return r?.[0]?.result || null;
  } catch (e) { return null; }
}
async function locateCoupon(tabId, pat) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageLocateCoupon, args: [pat] });
    return r?.[0]?.result || null;
  } catch (e) { return null; }
}
async function scanButtons(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageScanButtons });
    return r?.[0]?.result || [];
  } catch (e) { console.log('[京东领券] scanButtons失败:', e.message); return []; }
}
async function scanHourClaims(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageScanHourClaims });
    // 读取诊断数据
    const diag = await chrome.scripting.executeScript({ target: { tabId }, func: () => window.__jdScanDiag || null });
    const d = diag?.[0]?.result;
    if (d) console.log('[scanDiag]', JSON.stringify(d));
    return r?.[0]?.result || [];
  } catch (e) { console.log('[整点] scanHourClaims失败:', e.message); return []; }
}

async function scanHalfClaims(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageScanHalfClaims });
    var m = r?.[0]?.result || [];
    console.log('[scanHalf]', m.length, 'buttons:', m.slice(0,5).map(function(c){ return JSON.stringify(c); }).join(';'));
    return m;
  } catch (e) { console.log('[半点] scanHalfClaims失败:', e.message); return []; }
}


async function checkResult(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageCheckResult });
    return r?.[0]?.result || { success: false, message: '' };
  } catch (e) { return { success: false, message: '' }; }
}
async function readOutcome(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageReadOutcome });
    return r?.[0]?.result || '?';
  } catch (e) { return '?'; }
}
async function dumpDom(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageDumpDom });
    return r?.[0]?.result || [];
  } catch (e) { console.log('[京东领券] dumpDom失败:', e.message); return []; }
}

// =====================================================================
// 页面内函数（在网页上下文执行，不能引用外部变量）
// =====================================================================
function pageScrollLazyLoad() {
  return (async () => {
    window.scrollTo({ top: document.body.scrollHeight * 0.7, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 600));
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 600));
    window.scrollTo({ top: 0, behavior: 'instant' });
    await new Promise(r => setTimeout(r, 400));
  })();
}

// 注意：以下 pageXxx 函数通过 executeScript 注入到网页执行，
// 不能引用模块作用域的其它函数/变量 —— 每个都必须自包含（buildRe 各自内联）。
//
// 金额匹配规则：
// - "X-Y"：匹配 满?X(任意≤6字符,如"减")Y，且 Y 后不接数字 → 满29减20 / 29-20 / 29减20
// - "N"  ：匹配带货币符号的独立金额 N → ¥10 / ￥10 / 10元 / 立减10元；
//          排除 100、满10减5(满后阈值)、10:30(倒计时) 等误匹配
// 金额匹配（顺序无关）—— 必须内联在每个注入函数里（executeScript 不会带上外部函数）：
// "X-Y" → 匹配 满X减Y(inline) 或 (满X 阈值 + ¥Y/减Y 折扣) 任意顺序，
//          覆盖「满5减4」也覆盖「¥4 满5可用」这种折扣在前的写法。
// "N"   → 带货币符号的独立金额：¥10 / ￥10 / 10元 / 立减10元；排除 100 / 满10减5 / 10:30。
function pageLocateBanner(pat) {
  function makeMatcher(p) {
    const parts = String(p).split(/[-_]/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const X = parts[0], Y = parts[1];
      const reInline = new RegExp('(?<![0-9])满?\\s*' + X + '[^0-9]{1,6}' + Y + '(?![0-9])');
      const reThr = new RegExp('满\\s*' + X + '(?![0-9])');
      const reAmt = new RegExp('[¥￥减]\\s*' + Y + '(?![0-9])');
      return (t) => !!t && (reInline.test(t) || (reThr.test(t) && reAmt.test(t)));
    }
    const n = parts[0];
    const re = new RegExp('[¥￥]\\s*' + n + '(?![0-9.])|(?<![0-9.满])' + n + '\\s*元');
    return (t) => !!t && re.test(t);
  }
  const matches = makeMatcher(pat);
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (/^(SCRIPT|STYLE|HTML|BODY|HEAD|LINK|META)$/.test(el.tagName)) continue;
    const text = el.textContent || '';
    const alt = el.getAttribute && (el.getAttribute('alt') || '');
    const src = el.getAttribute && (el.getAttribute('src') || '');
    const href = el.getAttribute && (el.getAttribute('href') || '');
    const cls = typeof el.className === 'string' ? el.className : '';
    if (matches(text) || matches(alt) || matches(src) || matches(href) || matches(cls)) {
      let p = el;
      while (p) {
        const style = window.getComputedStyle(p);
        const clickable = p.tagName === 'A' || style.cursor === 'pointer' || p.onclick || (p.getAttribute && p.getAttribute('data-type') === 'view');
        const rect = p.getBoundingClientRect();
        if (clickable && rect.width > 200 && rect.height > 50) {
          return { x: Math.round(rect.left + rect.width / 2), y: Math.max(60, Math.round(rect.top + rect.height / 2)), w: Math.round(rect.width), h: Math.round(rect.height) };
        }
        p = p.parentElement;
      }
    }
  }
  // 兜底：常见大Banner容器
  const aAward = document.querySelector('a[href*="newBabelAwardCollection"]');
  const view = document.querySelector('[data-type="view"]');
  const img = document.querySelector('img[data-type="image"]');
  const el = aAward || view || img;
  if (el) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 50) {
      return { x: Math.round(rect.left + rect.width / 2), y: Math.max(60, Math.round(rect.top + rect.height / 2)), w: Math.round(rect.width), h: Math.round(rect.height) };
    }
  }
  return null;
}

function pageLocateCoupon(pat) {
  function makeMatcher(p) {
    const parts = String(p).split(/[-_]/).map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const X = parts[0], Y = parts[1];
      const reInline = new RegExp('(?<![0-9])满?\\s*' + X + '[^0-9]{1,6}' + Y + '(?![0-9])');
      const reThr = new RegExp('满\\s*' + X + '(?![0-9])');
      const reAmt = new RegExp('[¥￥减]\\s*' + Y + '(?![0-9])');
      return (t) => !!t && (reInline.test(t) || (reThr.test(t) && reAmt.test(t)));
    }
    const n = parts[0];
    const re = new RegExp('[¥￥]\\s*' + n + '(?![0-9.])|(?<![0-9.满])' + n + '\\s*元');
    return (t) => !!t && re.test(t);
  }
  const DONE = /已领取|已抢完|已抢光|已结束|明日再来|去使用|去试用|敬请期待/;
  const matches = makeMatcher(pat);
  const all = document.querySelectorAll('*');
  for (const el of all) {
    if (/^(SCRIPT|STYLE|HTML|BODY|HEAD|LINK|META)$/.test(el.tagName)) continue;
    const text = (el.textContent || '').trim();
    if (!text || text.length > 80) continue;
    if (!matches(text)) continue;

    // 从券文字向上找包含「领取按钮」的卡片
    let p = el;
    for (let i = 0; i < 6 && p; i++) {
      const btn = p.querySelector('[data-type="coupon_text_button"], button, [class*="btn"], [class*="button"], [class*="grab"], [class*="coupon-btn"]');
      if (btn && !DONE.test(btn.textContent || '')) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          return mk(rect);
        }
      }
      const cands = p.querySelectorAll('a,button,[class*="btn"],[class*="grab"]');
      for (const c of cands) {
        const ct = c.textContent || '';
        if (/领|抢|再来/.test(ct) && !DONE.test(ct)) {
          const rect = c.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return mk(rect);
        }
      }
      p = p.parentElement;
    }
  }
  // 兜底：任意一个可领取按钮
  const btn = document.querySelector('[data-type="coupon_text_button"]');
  if (btn && !DONE.test(btn.textContent || '')) return mk(btn.getBoundingClientRect());
  return null;

  function mk(rect) {
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.max(60, Math.round(rect.top + rect.height / 2)),
      absoluteY: Math.round(window.scrollY + rect.top + rect.height / 2)
    };
  }
}

// ===== 整点页：扫描所有"可领状态"的领取按钮（实测以此为唯一领取入口） =====
// 只认真实领取控件 [data-type="coupon_text_button"]（及半点页的 coupon-button-*），
// 商品列表里的「券丨满4减3」没有这类按钮，天然被排除。
// ⚠️ 关键：scanHourClaims 是 grabHourly 的扫描入口。v89 及之前只扫 coupon_text_button（小券），
// 大 banner 29-20 永远扫不到。修：合入 pageScanButtons 的大 banner 扫描逻辑。
// pageScanHourClaims 只在页面内注入执行，不在 background context，需要日志就写入 window.__jdScanDiag
function pageScanHourClaims() {
  var diag = { banner: { aAward:0, img:0, imgFound:0, view:0, viewFound:0 }, small:0, smallFiltered:0, fallbackClass:0, fallbackAll:0 };
  const out = [], seen = new Set();
  const add = (x, y, text, amount, absY) => {
    const key = x+','+y;
    if (seen.has(key)) return; seen.add(key);
    out.push({ text: (text||'').slice(0,16), amount: (amount||'').slice(0,40), x, y: Math.max(60, y), absoluteY: absY || (y + (window.scrollY||0)) });
  };

  // ===== 大 banner 扫描 =====
  var aAward = document.querySelectorAll('a[href*="newBabelAwardCollection"]');
  diag.banner.aAward = aAward.length;
  aAward.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width > 500 && r.height > 100) add(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2), el.textContent||'', '', Math.round(window.scrollY + r.top + r.height/2));
  });
  if (out.filter(a => a.text).length < 2) {
    var imgs = document.querySelectorAll('img[data-type="image"]');
    diag.banner.img = imgs.length;
    imgs.forEach(img => {
      const r = img.getBoundingClientRect();
      if (r.width > 1000 && r.height > 200) {
        diag.banner.imgFound++;
        let p = img.parentElement, d = 0;
        while (p && d < 10) {
          const pr = p.getBoundingClientRect();
          if (p.tagName === 'A' && pr.width > 500) {
            add(Math.round(pr.left+pr.width/2), Math.round(pr.top+pr.height/2), p.textContent||'', '', Math.round(window.scrollY + pr.top + pr.height/2));
            break;
          }
          p = p.parentElement; d++;
        }
      }
    });
  }
  if (out.filter(a => a.text).length < 2) {
    var views = document.querySelectorAll('[data-type="view"]');
    diag.banner.view = views.length;
    views.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 700 && r.height > 200) {
        diag.banner.viewFound++;
        let p = el.parentElement, d = 0;
        while (p && d < 10) {
          const pr = p.getBoundingClientRect();
          if ((p.tagName === 'A' || window.getComputedStyle(p).cursor === 'pointer') && pr.width > 500) {
            add(Math.round(pr.left+pr.width/2), Math.round(pr.top+pr.height/2), p.textContent||'', '', Math.round(window.scrollY + pr.top + pr.height/2));
            break;
          }
          p = p.parentElement; d++;
        }
      }
    });
  }

  // ===== 小券扫描 =====
  const DONE = /已抢光|已领取|已抢完|已结束|明日再来|去使用|去试用|敬请期待/;
  document.querySelectorAll('[data-type="coupon_text_button"], .coupon-button-text, .coupon-button-wrap').forEach(btn => {
    diag.small++;
    const t = (btn.textContent || '').trim().replace(/\s+/g, '');
    if (!t || DONE.test(t)) { diag.smallFiltered++; return; }
    const r = btn.getBoundingClientRect();
    if (r.width < 20 || r.height < 10) { diag.smallFiltered++; return; }
    let amount = '', p = btn;
    for (let i = 0; i < 6 && p; i++) {
      const ct = (p.textContent || '').replace(/\s+/g, '');
      if (ct.length < 60 && /满\d|[¥￥]\d|\d+元|金券/.test(ct)) { amount = ct.slice(0, 40); break; }
      p = p.parentElement;
    }
    add(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2), t, amount, Math.round(window.scrollY + r.top + r.height/2));
  });

  // ===== 兜底：class 包含 coupon =====
  if (out.length === 0) {
    var classEls = document.querySelectorAll('[class*="free_coupon"], [class*="hour_coupon"], [class*="Coupon"], [class*="coupon"]');
    diag.fallbackClass = classEls.length;
    classEls.forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width < 50 || r.height < 20) return;
      const isBig = r.width > 500 && r.height > 100;
      if (isBig) {
        let p = el.parentElement, d = 0;
        while (p && d < 10) {
          const pr = p.getBoundingClientRect();
          if ((p.tagName === 'A' || window.getComputedStyle(p).cursor === 'pointer') && pr.width > 500) {
            add(Math.round(pr.left+pr.width/2), Math.round(pr.top+pr.height/2), p.textContent||'', '', Math.round(window.scrollY + pr.top + pr.height/2));
            break;
          }
          p = p.parentElement; d++;
        }
        if (!p || d >= 10) add(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2), el.textContent||'', '', Math.round(window.scrollY + r.top + r.height/2));
      } else {
        const text = (el.textContent || '').trim();
        if (/再来|领取|抢|券/.test(text) && !/已领取|已结束/.test(text))
          add(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2), text, '', Math.round(window.scrollY + r.top + r.height/2));
      }
    });
  }

  // ===== 最终兜底：含「再来/领取/开抢」文字的任意可点击元素 =====
  if (out.length === 0) {
    document.querySelectorAll('*').forEach(el => {
      if (/^(STYLE|SCRIPT|HTML|BODY|HEAD|LINK|META)$/.test(el.tagName)) return;
      const text = (el.textContent || '').trim();
      if (!/再来|领取|开抢/.test(text)) return;
      if (/已领取|已结束/.test(text) && !/再来/.test(text)) return;
      if (text.length > 200) return;
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 15) return;
      const isBigEl = r.width > 1000;
      if (!isBigEl) {
        const style = window.getComputedStyle(el);
        if (!(el.tagName === 'A' || style.cursor === 'pointer' || el.onclick)) return;
      }
      add(Math.round(r.left+r.width/2), Math.round(r.top+r.height/2), text, '', Math.round(window.scrollY + r.top + r.height/2));
    });
  }

  window.__jdScanDiag = diag;
  return out;
}

// ===== 通用扫描按钮（半点 + 整点兜底） =====
function pageScanButtons() {
  const results = [];
  const seenKeys = new Set();

  function addEl(el, type) {
    const text = (el.textContent || '').trim().substring(0, 60);
    const rect = el.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 10) return;
    if (rect.bottom < 0 || rect.top > window.innerHeight) return;
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    const key = cx + ',' + cy;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r2 = el.getBoundingClientRect();
    results.push({
      type, text,
      x: Math.round(r2.x + r2.width / 2),
      y: Math.max(60, Math.round(r2.y + r2.height / 2)),
      w: Math.round(r2.width), h: Math.round(r2.height),
      area: Math.round(r2.width * r2.height)
    });
  }

  // 整点(pro.m.jd.com)
  if (location.hostname.includes('pro.m.jd.com')) {
    const aAward = document.querySelectorAll('a[href*="newBabelAwardCollection"]');
    aAward.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 500 && rect.height > 100) addEl(el, 'big');
    });
    if (results.filter(b => b.type === 'big').length === 0) {
      document.querySelectorAll('img[data-type="image"]').forEach(img => {
        const rect = img.getBoundingClientRect();
        if (rect.width > 1000 && rect.height > 200) {
          let parent = img.parentElement, depth = 0;
          while (parent && depth < 10) {
            const pRect = parent.getBoundingClientRect();
            if (parent.tagName === 'A' && pRect.width > 500) { addEl(parent, 'big'); break; }
            parent = parent.parentElement; depth++;
          }
        }
      });
    }
    if (results.filter(b => b.type === 'big').length === 0) {
      document.querySelectorAll('[data-type="view"]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 700 && rect.height > 200) {
          let parent = el.parentElement, depth = 0;
          while (parent && depth < 10) {
            const pRect = parent.getBoundingClientRect();
            if ((parent.tagName === 'A' || window.getComputedStyle(parent).cursor === 'pointer') && pRect.width > 500) { addEl(parent, 'big'); break; }
            parent = parent.parentElement; depth++;
          }
        }
      });
    }
    document.querySelectorAll('[data-type="coupon_text_button"]').forEach(el => {
      const text = (el.textContent || '').trim();
      if (text.includes('已领取') || text.includes('已结束')) return;
      let isInBig = false, parent = el.parentElement;
      for (let i = 0; i < 10 && parent; i++) {
        try { if (parent.getBoundingClientRect().width > 700) { isInBig = true; break; } } catch (e) {}
        parent = parent.parentElement;
      }
      if (!isInBig) addEl(el, 'small');
    });
    if (results.length === 0) {
      document.querySelectorAll('[class*="free_coupon"], [class*="hour_coupon"], [class*="Coupon"]').forEach(el => {
        const rect = el.getBoundingClientRect();
        if (rect.width > 500 && rect.height > 100) {
          let parent = el.parentElement, depth = 0;
          while (parent && depth < 10) {
            const pRect = parent.getBoundingClientRect();
            if ((parent.tagName === 'A' || window.getComputedStyle(parent).cursor === 'pointer') && pRect.width > 500) { addEl(parent, 'big'); break; }
            parent = parent.parentElement; depth++;
          }
        } else if (rect.width > 50 && rect.height > 20) {
          const text = (el.textContent || '').trim();
          if (/再来|领取|抢|券/.test(text) && !/已领取|已结束/.test(text)) addEl(el, 'small');
        }
      });
      document.querySelectorAll('*').forEach(el => {
        if (/^(STYLE|SCRIPT|HTML|BODY|HEAD|LINK|META)$/.test(el.tagName)) return;
        const text = (el.textContent || '').trim();
        if (!/再来|领取|开抢/.test(text)) return;
        if (/已领取|已结束/.test(text) && !/再来/.test(text)) return;
        if (text.length > 200) return;
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 15) return;
        const isBigEl = rect.width > 1000;
        if (!isBigEl) {
          const style = window.getComputedStyle(el);
          if (!(el.tagName === 'A' || style.cursor === 'pointer' || el.onclick)) return;
        }
        addEl(el, isBigEl ? 'big' : 'small');
      });
    }
  }

  // 半点(hour.jd.com)
  if (location.hostname.includes('hour.jd.com')) {
    document.querySelectorAll('[data-type="coupon_text_button"]').forEach(el => {
      const text = (el.textContent || '').trim();
      if (!/再来|领取|抢|券|开抢|抢光/.test(text)) return;
      if (/已领取|已结束/.test(text) && !/再来/.test(text)) return;
      addEl(el, 'small');
    });
    document.querySelectorAll('.coupon-card, .coupon-button-wrap, .grab-coupon-floor__tab-item').forEach(el => {
      const text = (el.textContent || '').trim();
      if (!/再来|领取|抢|券|开抢|抢光/.test(text)) return;
      if (/已领取|已结束/.test(text) && !/再来/.test(text)) return;
      addEl(el, 'small');
    });
  }

  return results.sort((a, b) => b.area - a.area);
}

// 读取整点抢券的真实结果（区分 领到 / 已抢完 / 还在卖 / 下一场）——用于计时日志复盘
function pageReadOutcome() {
  const body = (document.body && document.body.innerText || '').replace(/\s+/g, '');
  let toast = '';
  document.querySelectorAll('.babel-notice, [class*="notice"], [class*="toast"]').forEach(el => {
    const t = (el.textContent || '').trim().replace(/\s+/g, '');
    if (t && t.length < 44) toast = t;
  });
  if (/领取成功|恭喜/.test(toast)) return '✅领取成功|' + toast;
  if (/已抢完|已抢光|本时段优惠券已抢完/.test(toast)) return '❌已抢完|' + toast;
  if (/已领取|今日已领/.test(toast)) return '🔁已领取|' + toast;
  const btn = document.querySelector('[data-type="coupon_text_button"]');
  // Strip whitespace + zero-width/nbsp chars (handles invisible spacers in JD button text)
  const bt = btn ? (btn.textContent || '').replace(/[\s\u00a0\u200b\u200c\u200d\u200e\u200f\u2060\u3000\ufeff]/g, '') : '';
  if (/领取成功/.test(body)) return '✅领取成功(body)';
  if (/已领取/.test(bt)) return '🔁已领取|btn=' + bt;
  if (/已抢完|已抢光/.test(bt)) return '❌已抢完|btn=' + bt;
  if (/去使用|去试用/.test(bt)) return '✅已领取(去使用)|btn=' + bt; // coupon claimed, ready to use
  if (/再来/.test(bt)) return '⏭️本场已结束|btn=' + bt;          // 如 19:00再来
  if (/立即领取|开抢|马上抢/.test(bt)) return '🟡仍显示可领|btn=' + bt; // 点了无 toast=多半已抢完(按钮不更新)
  return '❓未知|btn=' + bt;
}

function pageCheckResult() {
  const allEls = document.querySelectorAll('*');
  for (const el of allEls) {
    try {
      const style = window.getComputedStyle(el);
      if (style.position !== 'fixed' && style.position !== 'absolute') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 30 || rect.height < 20 || rect.width > 600 || rect.height > 400) continue;
      const text = (el.textContent || '').replace(/\s+/g, '');
      if (text.includes('已抢完') || text.includes('领取成功') || text.includes('恭喜') || text.includes('本时段优惠券已抢完')) {
        return { success: true, message: text.substring(0, 30) };
      }
    } catch (e) {}
  }
  const bodyText = (document.body?.innerText || '').replace(/\s+/g, '');
  if (bodyText.includes('本时段优惠券已抢完')) return { success: true, message: '已抢完' };
  if (bodyText.includes('领取成功')) return { success: true, message: '领取成功' };
  return { success: false, message: '' };
}

function pageDumpDom() {
  const results = [];
  document.querySelectorAll('*').forEach(el => {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 40) return;
      if (rect.width < 200 && rect.height < 50) return;
      if (rect.bottom < 0 || rect.top > window.innerHeight * 2) return;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return;
      const tag = el.tagName.toLowerCase();
      const cls = (el.className && typeof el.className === 'string') ? el.className.split(' ').slice(0, 3).join('.') : '';
      const href = tag === 'a' ? (el.getAttribute('href') || '').substring(0, 80) : '';
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').substring(0, 60);
      results.push({ tag, cls, href, text, w: Math.round(rect.width), h: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) });
    } catch (e) {}
  });
  results.sort((a, b) => (b.w * b.h) - (a.w * a.h));
  return results.slice(0, 60);
}

// =====================================================================
// 半点点击逻辑 v61（严格只领 HALF_TARGET，如 5-4；早刷新 + 等渲染 + 长间隔重刷）
// 实测：半点券"临近才出现、过点即消失"，且该 SPA 加载要 10~60s。
//   ⚠️ 旧版每 6s 重刷会不断打断尚未加载完的页面 → 永远加载不出来。
// 策略：T-90s 早刷新 → 轮询等页面真正渲染(楼层出现，保活 SW) → 在 [≈T, T+120s] 窗口内
//        每 ~1.5s 扫一次，发现可领的 5-4 就狂点(≤3次/秒)；长时间(≥45s)找不到才再刷一次。
//        全程只认 5-4，绝不乱点；卖完(已抢完)由 checkResult 判定并停止。
// targetTime: 半点目标时间戳(ms)；传 0 = 立即测试
// =====================================================================
// =====================================================================
// 半点专用扫描（轻量，不复用 pageScanHourClaims 那块整点巨无霸）
// 只扫 coupon_text_button，不碰大 banner
// =====================================================================
function pageScanHalfClaims() {
  const out = [], seen = new Set();
  const DONE = /已抢光|已领取|已抢完|已结束|明日再来|去使用|去试用|敬请期待/;
  // 支持 Taro 框架选择器（小程序 Web 容器）+ 标准选择器
  const selectors = [
    '[data-type="coupon_text_button"]',
    '.coupon-button-text',
    '.coupon-button-wrap',
    '.coupon-bu',
    '.grab-coup [class*="coupon"], .grab-coup [class*="button"]',
  ];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(function(btn) {
      const t = (btn.textContent || '').trim().replace(/\s+/g, '');
      if (!t || DONE.test(t)) return;
      const r = btn.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) return;
      let amount = '', p = btn;
      for (let i = 0; i < 6 && p; i++) {
        const ct = (p.textContent || '').replace(/\s+/g, '');
        if (ct.length < 60 && /满\d|[¥￥]\d|\d+元|金券/.test(ct)) { amount = ct.slice(0, 40); break; }
        p = p.parentElement;
      }
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const key = cx + ',' + cy;
      if (seen.has(key)) return; seen.add(key);
      out.push({ text: t.slice(0, 16), amount: amount.slice(0, 40), x: cx, y: Math.max(60, cy), absoluteY: Math.round(window.scrollY + r.top + r.height / 2) });
    });
  }
  return out;
}

// v103.1: fires=0 时快照页面上所有按钮文字+class，用于区分「京东没放券」还是「有券但选择器/刷新时机漏了」
async function snapHalfButtons(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN',
      func: () => {
        const sels = '[data-type="coupon_text_button"],.coupon-button-text,.coupon-button-wrap,.coupon-bu,.grab-coup,[class*="coupon"],[class*="button"]';
        const out = [];
        for (const b of document.querySelectorAll(sels)) {
          // v123: 文案放宽到 60 字（拼接长文案 40 字会被切掉关键状态词）；
          // 并记录中心坐标 —— 可直接和 clickrec 里 humanFirst 的人工手点坐标对照，
          // 9/10 11:30/16:30 人工手点是 (394,454)/(395,380)，扩展算的坐标对不上一眼就能看出来。
          const t = (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          if (!t) continue;
          const r = b.getBoundingClientRect();
          out.push({
            t, c: (b.className && b.className.toString().slice(0, 30)) || '',
            x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
            w: Math.round(r.width), h: Math.round(r.height)
          });
        }
        return out.slice(0, 40);
      }
    });
    return r?.[0]?.result || [];
  } catch (e) { return []; }
}

// v131: 10:29 按钮检测（等价于「OCR 看页面还有没有按钮」）。注入页面执行，读 DOM 判断目标券卡片状态，
// 并抽取按钮提示的开抢时间。返回 {hasButton, state, btnTime, btnText}。
function pageCheckJdButton() {
  const DONE = /已抢光|已领取|已抢完|已结束|明日再来|去使用|去试用|立即使用|去下单|去支付|敬请期待/;
  const CLAIMABLE = /立即领取|马上抢|立刻抢|去抢|立即抢|抢券|抢购|一键领|0元领|0元购|免费领|限时抢|领取|正在抢券中/;
  const NOPOKE = /提醒|闹钟|remind|Remind|预约/;
  // v132: 页面导航按钮绝不能被当成券按钮。
  // 10/21 实证：prescan 返回 {hasButton:true, state:'soon', btnText:'搜索'} —— 向上找 8 层会摸到
  // 某个巨型容器（其 textContent 里含「超补好运券」），于是「搜索」按钮也算"在券卡片内"，
  // 10:30 带着 hasButton=true 空跑一整轮，clicks=0（看起来就像京东不放券）。
  const NOTCOUPON = /^(搜索|搜索商品|购物车|我的|首页|消息|分类|关注|推荐|全部|更多|返回|分享|客服|登录|注册|筛选|排序|评价|详情|加入购物车|立即购买)$/;
  const CARD = /满5减4|5-4|5减4|满5可用|满2可用|超补好运|好运券|正在抢券中/;
  const norm = (s) => (s || '').replace(/\s+/g, '');
  const SPEC = '[data-type="coupon_text_button"],.coupon-button-text,.coupon-button-wrap,.coupon-bu';
  const BROAD = '[class*="coupon"],[class*="button"]';
  const inTargetCard = (el) => {
    let n = el;
    for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
      const t = norm(n.textContent);
      if (t.length > 600) break; // v132: 巨型容器（整页楼层）不是"卡片"，否则任意按钮都算命中
      if (CARD.test(t)) return true;
    }
    return false;
  };
  const candidates = [];
  const consider = (el) => {
    const rc = el.getBoundingClientRect();
    if (rc.width <= 0 || rc.height <= 0) return;
    const t = norm(el.textContent);
    if (!t) return;
    if (NOTCOUPON.test(t)) return; // v132: 搜索/购物车/我的 等导航按钮不是券按钮
    candidates.push({ t, card: inTargetCard(el) });
  };
  document.querySelectorAll(SPEC).forEach(consider);
  if (!candidates.length) document.querySelectorAll(BROAD).forEach(consider);
  // v132: 认不出也不许把整轮枪毙 —— 返回 unknown 让 10:30 照常刷新+扫描（宁可空跑一次，不可漏抢一轮）
  if (!candidates.length) return { hasButton: true, state: 'unknown', btnTime: null, btnText: '' };
  const pool = candidates.filter(c => c.card).length ? candidates.filter(c => c.card) : candidates;
  // 抽取按钮提示的开抢时间（紧邻"开抢/抢券时间"的 HH:MM，退而求其次取卡片内任意 HH:MM）
  let btnTime = null;
  for (const c of pool) { const m = c.t.match(/(?:开抢|开始|抢券时间|开抢时间)\D*(\d{1,2}):(\d{2})/); if (m) { btnTime = m[1] + ':' + m[2]; break; } }
  if (!btnTime) for (const c of pool) { const m = c.t.match(/(\d{1,2}):(\d{2})/); if (m) { btnTime = m[1] + ':' + m[2]; break; } }
  let state = 'soon', btnText = '';
  for (const c of pool) {
    if (NOPOKE.test(c.t)) continue;
    btnText = c.t.slice(0, 24);
    if (DONE.test(c.t)) state = 'done';
    else if (CLAIMABLE.test(c.t) && !/\d{1,2}:\d{2}/.test(c.t)) state = 'claimable';
    else state = 'soon';
    break;
  }
  return { hasButton: state !== 'done', state, btnTime, btnText };
}

async function startHalfClicking(tabId, targetTime) {
  const immediate = !targetTime || targetTime <= 0;
  console.log(`[半点] 目标券 "${HALF_TARGET}" ${immediate ? '(立即测试)' : new Date(targetTime).toLocaleTimeString()}`);
  // v132: 半点券面额每天都变（10/21 页面发的是「满4减3」，旧逻辑只认 5-4 → 整轮 clicks=0，看起来像"京东不放券"）。
  // 优先精确 5-4；没有就退到「超补好运券」系列（同一类每天常驻券），但不放宽到页面其它券（35减12/餐补券）。
  const HALF_LOOSE = /超补好运|好运券|超级补|天天领/;
  const pick = (claims) => {
    const ok = claims.filter(c => {
      const txt = (c.text || '');
      // 过滤DONE状态：按钮显示已抢光/已结束/明日再来，点击无用
      if (/已抢光|已领取|已抢完|已结束|明日再来/.test(txt)) return false;
      // 过滤时间文字：半点到点前按钮显示"16:30再来"，点击无用
      if (/\d{1,2}:\d{2}/.test(txt)) return false;
      return true;
    });
    const exact = ok.filter(c => bgMatch(HALF_TARGET, (c.amount || '') + ' ' + (c.text || '')));
    if (exact.length) return exact;
    return ok.filter(c => HALF_LOOSE.test((c.amount || '') + ' ' + (c.text || '')));
  };
  const T0h = targetTime || Date.now();
  const halfLog = []; let firstHalfClickOff = null; let lastClickRec = null;
  // v98: 打点即时落盘（崩溃自证）
  const hstamp = (l) => {
    const o = Date.now() - T0h; halfLog.push(`${l}@${o}ms`); console.log(`[半点] ${l} @${o}ms`);
    chrome.storage.local.set({ liveRound: { round: 'half-' + new Date(T0h).toTimeString().slice(0, 5), type: 'half', at: Date.now(), events: halfLog } }).catch(() => {});
  };
  hstamp('start');
  gWebReqs = []; // v98.1: 半点也捕获 API 请求
  // v107: 立即测试时直接提前台；正式轮改为 T=0 附近瞬间 pop(见 runScheduledClaim 前)，不长期抢焦点
  if (immediate) await focusTabForUser(tabId).catch(() => {});

  // v98.1: 半点结束时打点唯一 functionId + 疑似领券 API（16:30 诊断关键）
  const hNetSummary = async () => {
    try {
      const rec = await readClickRecorder(tabId);
      if (rec) { lastClickRec = rec; hstamp('clickrec:' + JSON.stringify(rec).slice(0, 160)); }
    } catch (e) {}
    try {
      if (!gWebReqs.length) { hstamp('web:0'); return; }
      const fids = [...new Set(gWebReqs.map(r => {
        const m = r.url.match(/functionId=([^&]+)/); return m ? m[1] : r.url.replace(/^https:\/\//, '').slice(0, 40);
      }))];
      hstamp('web-fids(' + gWebReqs.length + '):' + fids.slice(0, 15).join(','));
      gWebReqs.filter(r => /coupon|Coupon|receive|Receive|draw|Draw|lq|getCoupon/.test(r.url))
        .slice(0, 3).forEach((r, i) => hstamp('claim-api' + i + ':' + r.url.slice(0, 100)));
    } catch (e) {}
  };

  try { await chrome.debugger.detach({ tabId }); } catch (e) {}
  // 刷新并等页面真正渲染出优惠券楼层
  const reloadAndLoad = async (until) => {
    try { hstamp(await healOrReload(tabId, HALF_TARGET_URL, FULL_HALF_URL)); console.log('[半点] 刷新，等待渲染…'); } catch (e) {}
    const cap = Math.min(until, Date.now() + 70000);
    while (Date.now() < cap) {
      await sleep(1000);
      try {
        const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!document.querySelector('.grab-coupon-floor, .coupon-amount-section, [data-type="coupon_text_button"]') });
        if (r?.[0]?.result) break;
      } catch (e) {}
    }
    await scrollLazyLoad(tabId);
  };
  // 用新的 Taro 选择器扫描券
  const grabCoupSelector = [
    '[data-type="coupon_text_button"]',
    '.coupon-button-text',
    '.coupon-button-wrap',
    '.coupon-bu',
    '.grab-coup [class*="coupon"], .grab-coup [class*="button"]',
  ].join(', ');
  const checkExists = async () => {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: (selector) => !!document.querySelector(selector),
        args: [grabCoupSelector]
      });
      return r?.[0]?.result;
    } catch (e) { return false; }
  };

  // v98.2: 窗口终点 —— 用户策略：T=0 起持续点击 1 分钟
  const windowEnd = immediate ? Date.now() + 15000 : targetTime + 60000;

  // 提前打开/刷新并等渲染（登录态 + 页面活着 + handler 可注入）
  if (!immediate) {
    await sleepUntil(targetTime - 90000);
    await reloadAndLoad(targetTime - 8000);
  }
  else await scrollLazyLoad(tabId);
  // v110+: 登录跳转持续监听 —— 与点击窗口并行；窗口内每 15s 重复弹 🔴 通知提醒登录，直到恢复
  const loginWatchP = watchLoginRedirect(tabId, targetTime, hstamp);

  // v101: 页面自调度狂发 —— arm 后由页面自己的定时器在 T-300ms 精确开火(SW 挂起/迟缓也照打)，
  // 持续到 T+60s。不再空等 sleepUntil(T=0)(会被 MV3 杀 SW) 也不再 T=0 reload(会冲掉注入且依赖 SW 准时)。
  // 半点 5-4 窗口长，force 直调 handler 实时签名，不需要 reload 把按钮翻成可领态。
  // v105: 【撤销 v104 的 T-3s 刷新】—— 实测 7/17 10:30 半点 firstFireOff=6400(首点比 :30 晚 6.4s)。
  // 原因: T-90s 已经 reload+等券楼层渲染完毕并 arm 了 __jdScheduleRapid(首点定在 T-399ms)；
  // 而 T-3s 的二次 reload 把页面 JS 上下文整个清空，内部调度器随之销毁，必须等重载完成(resize/heavy Taro 页要 6s+)才能自愈重新 arm，
  // 于是首点落到 T+6.4s，券早被抢光(400 次点击全打在已结束按钮上)。
  // hour.jd.com 是重 SPA，3s 缓冲根本不够它 reload 完；且半点 force 直调 handler 实时签名、本就不需要 reload 把按钮翻成可领态(见 v101 注释)。
  // 因此半点流程【不再二次刷新】，保留 T-90s 那次(reloadAndLoad 已等券楼层出现)，调度器从 T-399ms 一直活到 T+60s，首点稳定落在 :30 前后 ~1ms。
  // 若日后想要"开抢前最新鲜"的页面，应把刷新提前到 T-8s 以上(给足重载时间)而非 T-3s。
  // v108: 半点依然 T=0 切前台点券；点击窗口 60s，1 分钟后(=点完)切回原 Tab(同一窗口里 pop 前的活动 tab)
  // v109: 半点每次 burst 重新定位券按钮(scrollIntoView+getBoundingClientRect)返回视口中心
  // v117: 【卡片锚点定位 —— 不再等按钮文案翻牌】
  // 旧逻辑要求按钮文案同时满足 CLAIMABLE 且非 DONE 且不含时间，等于"必须等客户端把
  // 「待开抢」翻成「立即抢券」才出坐标"。实测 9/02 10:30 客户端 26.4s 才翻牌 → first-fire@+26461ms，
  // 整轮库存早被抢空(362 次点击全是马后炮)。服务器 T=0 就开放，客户端翻牌有延迟，等它纯属自损。
  // 新逻辑：先按券面特征锚定「¥4满5可用/超补好运券」卡片(容器文案不随时态变)，再在卡片内取按钮本体，
  // 于是 T-1.2s 就能锁定坐标开点，抢在翻牌之前直接打服务器。
  const halfGetXY = async () => {
    try {
      const r = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: () => {
        const DONE = /已抢光|已领取|已抢完|已结束|明日再来|去使用|去试用|立即使用|去下单|去支付|敬请期待/;
        const HAS_TIME = /\d{1,2}:\d{2}/;
        const CLAIMABLE = /立即领取|马上抢|立刻抢|去抢|立即抢|抢券|抢购|一键领|0元领|0元购|免费领|限时抢|领取|正在抢券|抢券中/;
        // v123: 该页按钮 textContent 是「多场次拼接」的长文案，17:30 实测 38 字：
        //   "10:30已结束16:30正在抢券中10:30待开抢¥4满5可用超补好运券已抢光"
        // 里面既有别的场次的「已结束」，也有本场的「正在抢券中」，末尾还挂着「已抢光」。
        const LIVE = /正在抢券中|抢券中/;
        // 券卡片特征（容器级文案，倒计时/翻牌都不会变）
        const CARD = /满5减4|5-4|5减4|满5可用|满2可用|超补好运|好运券|正在抢券中/;
        const NOPOKE = /提醒|闹钟|remind|Remind|预约/;   // 别点到"开抢提醒"
        const SPEC = '[data-type="coupon_text_button"],.coupon-button-text,.coupon-button-wrap,.coupon-bu';
        const BROAD = '[class*="coupon"],[class*="button"]';
        const norm = (s) => (s || '').replace(/\s+/g, '');
        const inTargetCard = (el) => { let n = el; for (let i = 0; i < 8 && n; i++, n = n.parentElement) if (CARD.test(norm(n.textContent))) return true; return false; };
        const cands = []; let raw = 0, doneCnt = 0;
        const consider = (el, broad) => {
          const rc = el.getBoundingClientRect();
          if (rc.width <= 0 || rc.height <= 0) return;
          if (broad && (rc.width > 360 || rc.height > 110)) return;
          let t = norm(el.textContent);
          if (!t) return;
          // 旧阈值 >30 直接 return：38 字的拼接长文案会整颗被丢掉，连 raw 都不计 → 永远 all-done。
          // 过长就切出「正在抢券中」附近那一小段，只按这一段判状态（别处的状态词不该株连本场）。
          if (t.length > 30) {
            const i = t.search(LIVE);
            t = i >= 0 ? t.slice(Math.max(0, i - 10), i + 14) : t.slice(0, 30);
          }
          raw++;
          // 有「正在抢券中」就只受 NOPOKE 约束：本场是否真被抢光交给服务器响应判定，
          // 不能因为文案里挂着别场次的「已抢光/已结束」就把本场按钮判死。
          const dead = LIVE.test(t) ? NOPOKE.test(t) : (DONE.test(t) || NOPOKE.test(t));
          if (dead) { doneCnt++; return; }
          const w = Math.round(rc.width), h = Math.round(rc.height);
          cands.push({ el, t, w, h, area: w * h, card: inTargetCard(el), link: !!el.closest('a[href]'), claim: CLAIMABLE.test(t) && !HAS_TIME.test(t) });
        };
        document.querySelectorAll(SPEC).forEach(b => consider(b, false));
        if (!cands.length) document.querySelectorAll(BROAD).forEach(b => consider(b, true));
        // 档1：文案已是可领态（最稳，等价于旧逻辑）
        let pool = cands.filter(c => c.claim);
        let tier = 'claim';
        // 档2：文案还是"待开抢/倒计时"，但位于目标券卡片内且形状像按钮 → 照点(提前开火)
        if (!pool.length) {
          // v119: 预点档排除带 href 的链接元素。9/03 10:30 券已抢光后，预点档一直在点卡片里的
          // 链接元素，最终把页面点到 hour.jd.com/msstore/index，既没券又误报成功。
          pool = cands.filter(c => c.card && !c.link && c.w >= 40 && c.w <= 280 && c.h >= 16 && c.h <= 72);
          tier = 'card-prefire';
        }
        if (!pool.length) {
          const why = !raw ? 'no-elem' : (doneCnt && doneCnt >= raw ? 'all-done' : (cands.some(c => c.card) ? 'no-btn-shape' : 'no-target-card'));
          return { why };
        }
        // 命中 5-4 卡片优先；同档取面积最小(最具体的按钮本体，避开大容器)
        pool.sort((a, b) => (a.card === b.card ? 0 : (a.card ? -1 : 1)) || (a.area - b.area));
        const pick = pool[0];
        const tgt = pick.el;
        tgt.scrollIntoView({ block: 'center', behavior: 'instant' });
        const rc = tgt.getBoundingClientRect();
        const x = Math.round(rc.left + rc.width / 2), y = Math.round(rc.top + rc.height / 2);
        const el = document.elementFromPoint(x, y);
        const hit = !!(el && (tgt === el || tgt.contains(el) || el.contains(tgt)));
        return { x, y, hit, w: Math.round(rc.width), h: Math.round(rc.height), tier, card: pick.card, text: norm(tgt.textContent).slice(0, 16) };
      }});
      return r?.[0]?.result;
    } catch (e) { return { why: 'exc:' + (e.message || '').slice(0, 30) }; }
  };
  const popP = (!immediate) ? popTabAroundT0(tabId, targetTime, 800, 60000) : Promise.resolve();
  const res = await runScheduledClaim(tabId, hstamp, immediate ? Date.now() : targetTime, immediate ? 0 : 399, immediate ? 15000 : 60000, true, halfGetXY);
  await popP.catch(() => {});
  await loginWatchP.catch(() => {});
  if (res.fires === 0) { const snap = await snapHalfButtons(tabId); hstamp('half-snap(0-fire):' + JSON.stringify(snap).slice(0, 1500)); }
  // v123: 点了却零服务器响应同样要留快照 —— 9/10 16:30 就是这样（fires=637），
  // 当时日志里只有「点了 637 次」，没有按钮长什么样，事后完全无从判断点错了没有。
  else if (!res.resp) { const snap = await snapHalfButtons(tabId); hstamp('half-snap(点了无响应):' + JSON.stringify(snap).slice(0, 1500)); }
  if (res.firstFireOff != null) firstHalfClickOff = res.firstFireOff;
  if (res.won) { showNotification('✅ 半点领取成功', `${new Date(T0h).toLocaleTimeString()} 抢到 5-4 券！`); }
  else { await focusTabForUser(tabId, '⏰ 半点未抢到', `${new Date(T0h).toLocaleTimeString()} 扩展未抢到（${res.resp ? '已售罄/无券' : '无响应'}），可手动补点`); }
  await hNetSummary();
  let halfOutcome;
  if (res.won) halfOutcome = '✅领取成功|' + String(res.resp || '').slice(0, 50);
  else if (res.resp) halfOutcome = '❌' + String(res.resp).slice(0, 60);
  else halfOutcome = '🟡无服务器响应(未点到可领按钮? fires=' + res.fires + ')';
  hstamp('outcome:' + halfOutcome);
  if (res.fires > 0 && firstHalfClickOff === null) firstHalfClickOff = 0;
  showNotification(immediate ? '🧪 半点测试' : '半点结果', halfOutcome.slice(0, 80));
  try {
    const prev3 = (await chrome.storage.local.get('raceLog')).raceLog || [];
    const d0 = new Date(T0h); const roundH = immediate ? 'half-test' : `${String(d0.getHours()).padStart(2, '0')}:${String(d0.getMinutes()).padStart(2, '0')}:00`;
    const extN = (lastClickRec && lastClickRec.ext) || 0, humN = (lastClickRec && lastClickRec.human) || 0;
    const wonBy = res.won ? (humN > 0 ? 'human' : (res.fires > 0 || extN > 0 ? 'ext' : 'unknown')) : 'none';
    prev3.unshift({ date: d0.toISOString().slice(0, 10), round: roundH, type: 'half', outcome: halfOutcome, events: halfLog, clicks: res.fires, firstClickOff: firstHalfClickOff, fires: res.fires, ext: extN, human: humN, wonBy });
    await chrome.storage.local.set({ raceLog: prev3.slice(0, 30) });
  } catch (e) {}
  // v130: 不再自动下载(见 VERSION 注释)；raceLog 已写入 storage，options 页「导出」按钮手动触发。
}

// 选择目标按钮（整点兜底用）：取 1大 + 2小
function pickTargets(buttons, mode = 'hour') {
  const bigBtns = buttons.filter(b => b.type === 'big');
  const smallBtns = buttons.filter(b => b.type === 'small');
  const targets = [];
  if (bigBtns.length > 0) targets.push(bigBtns[0]);
  if (smallBtns.length >= 2) targets.push(smallBtns[0], smallBtns[1]);
  else if (smallBtns.length === 1) targets.push(smallBtns[0]);
  else if (bigBtns.length > 1) targets.push(bigBtns[1]);
  return targets;
}

// =====================================================================
// 标签页查找 / 自动创建
// =====================================================================
// v98.3: 页面内点击记录器 —— 判定 CDP 点击到底有没有以 click 事件抵达页面
// （16:30 实验：7492 次纯鼠标点击在活券按钮上 0 API 调用 —— 需要分清"click 没合成"还是"handler 无视"）
// v114: 记录落 localStorage(而非 window 变量) —— 抢中后页面会跳到同源结果页，window 变量随文档销毁，
// 这正是历轮 clickrec 恒为 0 的原因(读的是新文档)。localStorage 同源存活，跳转后仍可读回。
async function injectClickRecorder(tabId, reset) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, args: [!!reset], func: (doReset) => {
      const K = '__jdCR';
      if (doReset) { try { localStorage.setItem(K, '[]'); } catch (e) {} }
      if (window.__jdClickRec) return;
      window.__jdClickRec = true;
      const push = (o) => {
        try {
          const a = JSON.parse(localStorage.getItem(K) || '[]');
          if (a.length < 600) { a.push(o); localStorage.setItem(K, JSON.stringify(a)); }
        } catch (e) {}
      };
      document.addEventListener('mousedown', (e) => {
        push({ t: Date.now(), tr: e.isTrusted ? 1 : 0, x: Math.round(e.clientX), y: Math.round(e.clientY),
               tag: (e.target && (e.target.tagName + '.' + String(e.target.className).slice(0, 24))) || '?' });
      }, true);
    }});
  } catch (e) {}
}
// v114: 归因 —— 页面观测到的每个 mousedown，与 __dispatchLog(扩展自己发的时刻)按 ±80ms 配对。
// 配上的 = 扩展点的；配不上的 = 人手点的。CDP 事件 isTrusted 同为 true，只能靠时刻比对区分。
async function readClickRecorder(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      try { return JSON.parse(localStorage.getItem('__jdCR') || '[]'); } catch (e) { return []; }
    }});
    const obs = r?.[0]?.result || [];
    const disp = __dispatchLog.slice();
    let ext = 0; const human = [];
    for (const o of obs) {
      if (disp.some(d => Math.abs(d - o.t) <= 80)) ext++;
      else human.push({ x: o.x, y: o.y, tr: o.tr, off: o.t });
    }
    return { obs: obs.length, dispatched: disp.length, ext, human: human.length, humanFirst: human.slice(0, 3) };
  } catch (e) { return null; }
}

// v98: 刷新前自愈 —— 标签若停在错误页(h5st error.html)/登录页/任何非目标 URL，
// 直接导航回正确的完整 URL（裸 URL 会 302 到错误页，普通 reload 只会原地打转）
async function healOrReload(tabId, fragment, fullUrl) {
  try {
    const t = await chrome.tabs.get(tabId);
    const u = new URL(t.url || '');
    if (!(u.hostname + u.pathname).includes(fragment)) {
      await chrome.tabs.update(tabId, { url: fullUrl });
      return 'healed→' + fullUrl.slice(8, 40);
    }
  } catch (e) {}
  try { await chrome.tabs.reload(tabId); } catch (e) {}
  return 'reload';
}

async function getOrCreateTab(urlFragment, fullUrl, label) {
  const allTabs = await chrome.tabs.query({});
  // v98: 按 hostname+pathname 匹配（不含 query）。plogin 登录跳转 URL 的 returnurl 参数里
  // 含 hour.jd.com，旧版 includes 匹配会把登录页当目标页。
  const existing = allTabs.find(t => {
    try {
      const u = new URL(t.url || '');
      if (/plogin|passport|login/i.test(u.hostname)) return false;
      return (u.hostname + u.pathname).includes(urlFragment);
    } catch (e) { return false; }
  });
  if (existing) return existing.id;

  // 没找到 → 记录 + 通知 + 自动打开
  console.log(`[京东领券] ⚠️ 未找到${label}标签，自动创建…`);
  showNotification('⚠️ 标签已关闭', `未找到${label}页，已自动打开，请保持标签常驻`);
  try {
    const prev = (await chrome.storage.local.get('raceLog')).raceLog || [];
    prev.unshift({ date: new Date().toISOString().slice(0, 10), round: new Date().toTimeString().slice(0, 8), outcome: '⚠️no-tab→auto-create', events: ['no-tab@0ms'], clicks: 0, firstClickOff: null });
    await chrome.storage.local.set({ raceLog: prev.slice(0, 30) });
  } catch (e) {}
  if (!fullUrl) return null;
  const newTab = await chrome.tabs.create({ url: fullUrl, active: false });
  return newTab.id; // URL 已设置，页面在后台继续加载
}

// =====================================================================
// 闹钟
// =====================================================================
let alarmsEnabled = true;

// v99.5: 自适应发现半点券时段 —— 页面显示的抢券时段会变(10:30/16:30/17:00/18:00…)，
// 从页面时间轴读取 HH:MM + 状态，不再写死时段列表。
// v99.9: 两遍扫描 —— 先抓所有 HH:MM + 上下文窗口，再独立判断该时段状态。
// 不再要求「时间紧挨状态词」(避免券名夹在中间导致漏抓)，状态词可扩展。
async function discoverHalfSlots(tabId) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const t = document.body.innerText.replace(/\s+/g, ' ');
      const timeRe = /(\d{1,2}:\d{2})/g;
      const FUTURE = /即将开抢|待开抢|即将开始|即将开场|即将开放|预热|距开始|后开抢|马上开抢|即将开/;
      const LIVE   = /正在抢券中|抢券中|抢购中|进行中/;
      const END    = /已结束|已抢光|已抢完|已领取|明日再来|去使用|去试用|敬请期待/;
      const out = []; let m;
      while ((m = timeRe.exec(t))) {
        const time = m[1];
        const s = Math.max(0, m.index - 30), e = Math.min(t.length, m.index + 30);
        const ctx = t.slice(s, e);
        let state = '未知';
        if (END.test(ctx)) state = '已结束';
        else if (LIVE.test(ctx)) state = '正在抢券中';
        else if (FUTURE.test(ctx)) state = '即将开抢';
        if (state === '未知') continue; // 无状态信号：多半是面值/日期误匹配，丢弃
        out.push({ time, state, ctx: ctx.trim() });
      }
      const seen = {};
      for (const o of out) { if (!seen[o.time] || o.ctx.length > seen[o.time].ctx.length) seen[o.time] = o; }
      return Object.values(seen);
    }});
    return r?.[0]?.result || [];
  } catch (e) { return []; }
}
// 扫描当前 hour.jd.com 页，把"今天未来且非已结束"的时段写入 storage.halfSlots
async function refreshHalfSlots(tabId) {
  try {
    // v99.9: 轮询等待 SPA 时间轴渲染（Taro 首屏可能 10~60s 才出时段），避免读到空/骨架屏导致漏设闹钟
    const cap = Date.now() + 30000;
    while (Date.now() < cap) {
      try {
        const has = await chrome.scripting.executeScript({ target: { tabId }, func: () => /(\d{1,2}:\d{2})/.test(document.body.innerText) });
        if (has?.[0]?.result) break;
      } catch (e) {}
      await sleep(1500);
    }
    // v99.9: 滚动到底部再滚回顶部 —— 触发 Taro 虚拟滚动/懒加载，确保屏幕下方的时段也渲染进 DOM
    await scrollLazyLoad(tabId);
    // 滚动后等新内容渲染
    await sleep(2000);
    const slots = await discoverHalfSlots(tabId);
    if (!slots.length) return;
    const now = new Date(), future = [];
    for (const s of slots) {
      const [hh, mm] = s.time.split(':').map(Number);
      const when = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
      // 未来时段(留5分钟余量)且未结束 → 值得定闹钟；"正在抢券中"也留(窗口长)
      if (when.getTime() > now.getTime() - 5 * 60000 && !/已结束/.test(s.state)) future.push(hh + ':' + (mm < 10 ? '0' + mm : mm));
    }
    if (future.length) {
      // v105: 【合并而非覆盖】—— 之前用页面扫描结果直接覆盖 halfSlots，一旦某次扫描没列出 16:30(时段未到点/无状态词被丢弃)，
      // 就会把未来的 jd_half_16_30 闹钟永久删掉(setupAlarms 会 clearAll 再只按 halfSlots 重建)。7/17 16:30 整轮没响就是这原因。
      // 修复: 合并 = 默认时段基线(HALF_SLOTS) ∪ 已存 halfSlots ∪ 本次新发现，只增不删(过去时段 setupAlarms 会因 t<=now 自动跳过，无副作用)。
      const base = HALF_SLOTS;
      const prev = (await chrome.storage.local.get('halfSlots')).halfSlots || [];
      const merged = [...new Set([...base, ...prev, ...future])];
      await chrome.storage.local.set({ halfSlots: merged, halfSlotsAt: Date.now() });
      console.log('[半点] 自适应发现时段:', merged, '(来自页面状态)');
      // v129: 不再在此处 setupAlarms —— 心跳(每分钟)会按最新 halfSlots 自动补齐未来闹钟；
      // 这里立即 setupAlarms 会在 2min 宽限内把已过的 jd_prescan 重新补发 → 反复 reload 页面 → 反馈环。
      try {
        const as = await chrome.alarms.getAll();
        const armed = as.filter(a => a.name.startsWith('jd_half_')).map(a => a.name.replace('jd_half_', '').replace('_', ':'));
        console.log('[半点] 已自动定闹钟:', armed);
        showNotification('⏰ 已识别抢券时段', '自动定时: ' + merged.join(', '));
      } catch (e) {}
    }
  } catch (e) {}
}

async function setupAlarms() {
  const data = await chrome.storage.local.get(['targetHour', 'endHour', 'halfSlots', 'hourlyEnabled']);
  const startHour = data.targetHour ?? START_HOUR;
  const endHour = data.endHour ?? END_HOUR;
  // v116: 整点开关 —— false 时不创建 jd_hour_ 闹钟，整点(及并行特价狙击)两网页都不再自动抢；半点不受影响。
  const hourlyEnabled = data.hourlyEnabled !== false;
  // v105: 自适应时段 ∪ 默认基线 —— 即使 storage.halfSlots 被某次扫描写成子集(如只 [10:30])，
  // 也始终保留 HALF_SLOTS 基线时段，避免 7/17 16:30 那样整轮不响。
  const stored = Array.isArray(data.halfSlots) ? data.halfSlots : [];
  const slotList = [...new Set([...HALF_SLOTS, ...stored])];

  // v110+: 不用 clearAll —— MV3 SW 在 clearAll 发出后、callback 执行前可能被回收，
  // 会导致所有 alarm 被清空而新的没建上（整点闹钟全丢，表现为整点轮次完全不触发）。
  // 改为：先 create（同名幂等覆盖、建完即持久化），再清掉不再需要的旧 alarm。
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const want = new Set();
  let count = 0;
  // v126: 重载若发生在轮次开始后不久(≤2min)，仍建闹钟(Chrome 会以 past-due 立即补发一次)，
  // 避免「正好在轮次时刻重载 → 该轮闹钟被 t>now 跳过 → 整轮静默丢失」(用户 9/15 10:30 重载即踩此坑)。
  // 已存在的同名闹钟不重建，防心跳每分重复补发刷屏。
  const GRACE_MS = 2 * 60000;
  const existing = new Set((await chrome.alarms.getAll()).map(a => a.name));
  const armIfNeeded = (when, name) => {
    // v129: prescan = T-60s 刷新 hour.jd.com 页(与半点点击是【同一 tab】)。
    // 绝不在过去补发 —— 一旦 within GRACE_MS 把已过的 jd_prescan 重新创建，Chrome 会立即补发 →
    // 反复 reload 该 tab → 把正在抢的半点轮次冲掉(9/16 10:30 整轮没响就是这个反馈环)。
    // prescan 只在严格未来才建；half/hour 仍保留 v126 的 2min 宽限补发(应对轮次时刻重载)。
    const isPrescan = name.startsWith('jd_prescan_');
    if (isPrescan) {
      if (when > now.getTime()) {
        if (!existing.has(name)) { want.add(name); chrome.alarms.create(name, { when }); count++; }
        else want.add(name);
      }
      return isPrescan; // prescan 不进宽限分支
    }
    if (when > now.getTime() - GRACE_MS) {
      if (!existing.has(name)) { want.add(name); chrome.alarms.create(name, { when }); count++; }
      else want.add(name); // 已存在(可能 past-due 待补发)，保留不重建
      return true;
    }
    return false;
  };

  // v121: 整点轮次完全由 hourlyEnabled 管控(含 11:00)。开关关→整点全停(含并行特价狙击)，不再有豁免场次。
  const hourList = [];
  if (hourlyEnabled) { for (let h = startHour; h <= endHour; h++) hourList.push(h); }
  for (const h of hourList) {
    const t = new Date(today.getTime() + h * 3600000 - 95000); // 整点提前95s：早刷新(T-90s)+轮询等按钮(SPA加载要10~60s)
    armIfNeeded(t.getTime(), `jd_hour_${h}`);
  }
  for (const slot of slotList) {
    const [hh, mm] = String(slot).split(':').map(Number);
    const t = new Date(today.getTime() + hh * 3600000 + mm * 60000 - 95000); // 时段提前95s：开抢闹钟
    armIfNeeded(t.getTime(), `jd_half_${hh}_${mm}`);
    // v103.2: 用户要求 —— 半点前 1 分钟(10:29/16:29)铁定刷新 hour.jd.com 并扫描，确保券楼层是新鲜的
    const tp = new Date(today.getTime() + hh * 3600000 + mm * 60000 - 60000); // 提前60s
    armIfNeeded(tp.getTime(), `jd_prescan_${hh}_${mm}`);
  }
  // 清掉不再需要的旧 alarm（不 clearAll，避免 MV3 SW 回收导致全部丢失；漏清不影响功能，下次会再清）
  try {
    const all = await chrome.alarms.getAll();
    for (const a of all) {
      if (!(a.name.startsWith('jd_hour_') || a.name.startsWith('jd_half_') || a.name.startsWith('jd_prescan_'))) continue;
      if (want.has(a.name)) continue;                         // 仍需要的，保留
      // v110.2: 绝不清除"已到点却还没触发"的 past-due 闹钟 —— SW 在闹钟触发瞬间被回收时，
      // 该闹钟会以 past-due 状态残留；SW 再次醒来(任意原因)应让它立即补发，而非清掉(否则整轮丢失)。
      // 只清除"未来、但已不在 want 中"的陈旧闹钟(旧配置遗留)。
      if (a.scheduledTime > Date.now()) chrome.alarms.clear(a.name);
    }
  } catch (e) {}
  if (want.size === 0) {
    // 提前2小时唤醒 setupAlarms，避免与第一个整点闹钟时间重叠导致遗漏
    const earlyHour = Math.max(0, startHour - 2);
    const tomorrow = new Date(today.getTime() + 24 * 3600000 + earlyHour * 3600000);
    chrome.alarms.create('jd_tomorrow', { when: tomorrow.getTime() });
  }
  // v133: 每日「自载入」闹钟 —— 和 MGTV v1.3.14 同理：扩展内部拿不到磁盘真值
  //（getPackageDirectoryEntry 在本机恒返回 null；version.txt 只能读到已加载旧包），
  // 只能定时 reload 把磁盘代码装进来。10:20/16:20 距 prescan(T-60s) 足够远，不会打断本轮。
  // 前缀 jd_reload_ 不参与上面的 want 清理（本函数末尾创建，下次进来会被清后重建，无害）。
  for (const hh of [10, 16]) {
    const dd = new Date(today.getTime() + hh * 3600000 + 20 * 60000);
    if (dd.getTime() > Date.now() + 5000) chrome.alarms.create(`jd_reload_${hh}`, { when: dd.getTime(), periodInMinutes: 1440 });
  }
  // 每20分钟心跳，防止闹钟丢失（Chrome重启/SW回收后自愈）
  // v115.1: 心跳从 20min 改为 1min。MV3 SW 在无事件约 30s 即被回收，券闹钟前后若 SW 已死，
  // 派发会延迟到下次心跳(原 20min → 上午多轮晚 4~11min，10:30 实际 10:39 才启动、券窗已关→0 按钮)。
  // 1min 心跳尽量保持 SW 存活，让 when 闹钟准点派发。注意：若本机在券时刻休眠，任何扩展都无法补，需保持唤醒。
  chrome.alarms.create('jd_heartbeat', { periodInMinutes: 1 });
  console.log(`[京东领券] 闹钟已设 ${count} 个`);
}

// v98: 轮次崩溃也要留痕 —— 记录异常到 raceLog + 落盘文件
async function recordCrash(kind, roundLabel, err) {
  try {
    console.log(`[京东领券] 💥 ${kind} 轮崩溃:`, err);
    const { liveRound } = await chrome.storage.local.get('liveRound');
    const prev = (await chrome.storage.local.get('raceLog')).raceLog || [];
    prev.unshift({
      date: new Date().toISOString().slice(0, 10),
      round: roundLabel, type: kind,
      outcome: '💥崩溃:' + String(err && (err.stack || err.message || err)).slice(0, 200),
      events: (liveRound && liveRound.events) || [], clicks: 0, firstClickOff: null
    });
    await chrome.storage.local.set({ raceLog: prev.slice(0, 30) });
    // v130: 不再自动下载文件——避免 Chrome「下载前询问保存位置」时反复弹"保存"框卡住(用户 9/16 17:31 投诉"保存两次且停在保存页待确认")。
    // 数据已写入 chrome.storage.local.raceLog(上面 set)，options 页内联可见；需文件时由 options「导出」按钮手动触发。
    showNotification('💥 轮次崩溃', `${roundLabel} ${String(err && err.message || err).slice(0, 80)}`);
  } catch (e2) { console.log('[京东领券] recordCrash 也失败:', e2.message); }
}

// v125: 闹钟一唤醒必留痕（先于任何早退判断）。消除「0 日志、不知为何没跑」黑盒：
// 下次若 JD 没抢，看 raceLog 有没有 alarm-woke 即可定位——有=闹钟响了但被开关跳过；无=SW 根本没被唤醒(扩展被禁用/闹钟未建)。
async function jdAlarmWake(alarm, enabled, drift) {
  try {
    // v126: 心跳/明日闹钟是保活基础设施，绝不写 raceLog（否则每分钟重复落盘刷屏，正是用户吐槽的「重复保存log」）
    const isInfra = alarm.name === 'jd_heartbeat' || alarm.name === 'jd_tomorrow' || alarm.name.startsWith('jd_reload_');
    if (!isInfra) {
      const prev = (await chrome.storage.local.get('raceLog')).raceLog || [];
      prev.unshift({
        date: new Date().toISOString().slice(0, 10),
        round: alarm.name,
        type: 'alarm',
        outcome: 'alarm-woke' + (enabled ? '' : ' ⚠️alarmsEnabled=false(静默跳过)'),
        detail: 'name=' + alarm.name + ' 漂移=' + (drift >= 0 ? '+' : '') + drift + 's',
        events: [], clicks: 0, firstClickOff: null
      });
      await chrome.storage.local.set({ raceLog: prev.slice(0, 30) });
    }
    // v128: 闹钟唤醒【不再】每次导出文件——避免「一个轮次被 prescan×3+half×2 触发 5 次下载/覆盖 jd-racelog.json」。
    // 诊断用的 alarm-woke 仍写入 raceLog 数组；raceLog 不再自动导出，改由 options 页「导出」按钮手动下载(含全部唤醒留痕)。
    // 所有闹钟都更新 lastAlarm（轻量，便于诊断为何没抢）
    chrome.storage.local.set({ lastAlarm: { name: alarm.name, at: new Date().toLocaleTimeString(), schedDrift: drift, enabled } }).catch(() => {});
  } catch (e) {}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('jd_')) return;
  // v125: 先留痕再判断（alarmsEnabled 关 / hourlyEnabled 关都不再黑盒）
  const schedDrift = alarm.scheduledTime ? Math.round((Date.now() - alarm.scheduledTime) / 1000) : null;
  await jdAlarmWake(alarm, alarmsEnabled, schedDrift);
  if (!alarmsEnabled) { console.log('[京东领券] alarmsEnabled=false，静默跳过'); return; }
  // v124: 每次 SW 被闹钟唤醒先自体检版本（SW 不一定常驻，闹钟触发是最稳的唤醒点）
  jdSelfHealCheck().catch(() => {});
  chrome.storage.local.set({ lastAlarm: { name: alarm.name, at: new Date().toLocaleTimeString(), schedDrift } }).catch(() => {});
  // v133: 定时自载入 —— 把磁盘上的最新代码（SW + content）装进来，只在离任一半点/整点 ±4min 之外才做。
  if (alarm.name.startsWith('jd_reload_')) {
    try {
      const t2 = new Date(); t2.setHours(10, 30, 0, 0);
      const t3 = new Date(); t3.setHours(16, 30, 0, 0);
      const busy = [t2, t3].some(d => Math.abs(Date.now() - d.getTime()) < 240000);
      const prev2 = (await chrome.storage.local.get('raceLog')).raceLog || [];
      prev2.unshift({
        date: new Date().toISOString().slice(0, 10), round: alarm.name, type: 'self',
        outcome: busy ? 'reload:跳过(临近开抢)' : 'reload:载入磁盘最新版',
        detail: 'alarm=' + alarm.name + ' 当前VERSION=' + VERSION, events: [], clicks: 0, firstClickOff: null
      });
      await chrome.storage.local.set({ raceLog: prev2.slice(0, 30) });
      if (!busy) setTimeout(() => chrome.runtime.reload(), 200);
    } catch (e) {}
    return;
  }
  if (alarm.name === 'jd_tomorrow' || alarm.name === 'jd_heartbeat') {
    // v99.6: 每小时 reload-then-scan 两个页面 —— 保持登录/新鲜 + 自适应发现半点时段。
    // 心跳每20min触发，但 reload 动作用 storage.lastRescanAt 限流到每60min一次；
    // 且若 5 分钟内有抢券闹钟则跳过（不打断即将开始的领券）。
    try {
      const { lastRescanAt } = await chrome.storage.local.get('lastRescanAt');
      if (!lastRescanAt || Date.now() - lastRescanAt >= 60 * 60000) {
        const alarms = await chrome.alarms.getAll();
        const soon = alarms.some(a => (a.name.startsWith('jd_hour_') || a.name.startsWith('jd_half_')) && (a.scheduledTime - Date.now()) < 5 * 60000 && (a.scheduledTime - Date.now()) > -3 * 60000);
        if (!soon) {
          await chrome.storage.local.set({ lastRescanAt: Date.now() });
          const all = await chrome.tabs.query({});
          // 半点页：reload → 等渲染 → 自适应发现时段
          const ht = all.find(t => { try { return new URL(t.url || '').hostname.includes('hour.jd.com'); } catch (e) { return false; } });
          if (ht) { try { await chrome.tabs.reload(ht.id); } catch (e) {} await sleep(6000); await refreshHalfSlots(ht.id); }
          // 整点页：reload/自愈保持登录态与新鲜（时段固定:00，无需发现）
          const pt = all.find(t => { try { const u = new URL(t.url || ''); return u.hostname.includes('pro.m.jd.com') && u.pathname.includes('2BGmkjr2mbi81R4ozsAR1ragZcyh'); } catch (e) { return false; } });
          if (pt) { try { await healOrReload(pt.id, TARGET_URL, FULL_HOURLY_URL); } catch (e) {} }
          console.log('[京东领券] 每小时 reload-then-scan 完成');
        } else {
          console.log('[京东领券] 临近抢券，跳过本次 reload-then-scan');
        }
      }
    } catch (e) {}
    setupAlarms();
    return;
  }

  if (alarm.name.startsWith('jd_prescan_')) {
    // v131: 10:29 唯一决策点（用户策略：只在 T-60s 看一眼页面还有没有按钮，有则到点抢、无则暂停，其他操作不干扰）。
    // 只读注入 pageCheckJdButton 读 DOM（等价 OCR），绝不 reload —— reload 会冲掉半点点击会话（9/16 反馈环教训）。
    const parts = alarm.name.split('_'); const hh = parseInt(parts[2]); const mm = parts[3] != null ? parseInt(parts[3]) : 30;
    const label = `${hh}:${mm < 10 ? '0' + mm : mm}`;
    console.log(`[京东领券] 🔍 10:29 按钮检测: ${label} (T-60s)`);
    let chk = { hasButton: true, state: 'no-tab', btnTime: null, btnText: '' }; // 默认 hasButton=true：页面没开也不误杀本轮
    try {
      const all = await chrome.tabs.query({});
      const ht = all.find(t => { try { return new URL(t.url || '').hostname.includes('hour.jd.com'); } catch (e) { return false; } });
      if (ht) {
        const r = await chrome.scripting.executeScript({ target: { tabId: ht.id }, func: pageCheckJdButton }).catch(() => null);
        const res = r?.[0]?.result;
        if (res) chk = res; // 页面开着但确实无按钮/已抢完 → hasButton=false，jd_half_ 会暂停
      }
      await chrome.storage.local.set({ jdHalfDecision: { hh, mm, at: Date.now(), ...chk } });
      console.log('[京东领券] 🔍 按钮检测:', JSON.stringify(chk));
    } catch (e) {}
    return; // 不 reload、不 setupAlarms、不刷新时段 —— 本窗口其他操作暂停
  }

  if (alarm.name.startsWith('jd_hour_')) {
    // v116: 整点已暂停则不抢（含并行特价狙击），直接返回；半点分支不受影响。
    // v121: 11:00 已取消豁免，与其他整点场次一样受 hourlyEnabled 管控 —— 开关关则任何 jd_hour_ 都跳过。
    if ((await chrome.storage.local.get('hourlyEnabled')).hourlyEnabled === false) {
      console.log('[京东领券] 整点已暂停，跳过'); setupAlarms(); return;
    }
    const h = parseInt(alarm.name.split('_').pop());
    console.log(`[京东领券] ⏰ 整点闹钟: ${h}:00`);
    const targetTime = new Date(); targetTime.setHours(h, 0, 0, 0);
    const tMs = targetTime.getTime();
    const tabId = await getOrCreateTab(TARGET_URL, FULL_HOURLY_URL, '整点领券');
    // v110+: 超时保底 —— grabHourly 在 SW 长等待期间若被回收/卡死，收尾通知会丢失(表现为"整点没弹")。
    // 无论主流程是否跑完，T+22s 这里必定弹一条结果通知，确保用户有感知。
    const bail = setTimeout(() => {
      showNotification('⏰ 整点结果(超时保底)', `${h}:00:00 扩展疑似卡住未回报，请手动查看页面`);
    }, Math.max(0, (tMs + 22000) - Date.now()));
    // v113: 领券 与 ≤9.9 特价狙击 并行（不同 tab，互不干扰）。
    // 领券标签丢失时特价照跑，反之亦然 —— 一路挂了不拖累另一路。
    const jobs = [grabDeals(tMs).catch(e => recordCrash('deal', `${h}:00:00`, e))];
    if (tabId != null) jobs.push(grabHourly(tabId, tMs).catch(e => recordCrash('hour', `${h}:00:00`, e)));
    await Promise.allSettled(jobs);
    clearTimeout(bail);
    setupAlarms();
    return;
  }

  if (alarm.name.startsWith('jd_half_')) {
    // v99.5: 名字编码 HH_MM（自适应任意时段，如 17_00 / 10_30）
    const parts = alarm.name.split('_'); // ['jd','half','HH','MM']
    const hh = parseInt(parts[2]);
    const mm = parts[3] != null ? parseInt(parts[3]) : 30;
    const label = `${hh}:${mm < 10 ? '0' + mm : mm}:00`;
    console.log(`[京东领券] ⏰ 半点闹钟: ${label}`);
    // v131: 按 10:29 按钮检测决策执行（用户策略：无按钮则暂停，其他操作跳过）
    const dec = (await chrome.storage.local.get('jdHalfDecision')).jdHalfDecision;
    const decOk = dec && dec.hh === hh && dec.mm === mm;
    if (decOk && dec.hasButton === false) {
      console.log(`[京东领券] ⏸️ ${label} 按钮检测=无/已抢完(${dec.state})，暂停抢券，其他操作跳过`);
      await chrome.storage.local.set({ lastAlarm: { name: 'half-skip-' + label, at: new Date().toLocaleTimeString(), reason: dec.state, decision: dec } }).catch(() => {});
      setupAlarms();
      return;
    }
    const tabId = await getOrCreateTab(HALF_TARGET_URL, FULL_HALF_URL, '半点领券');
    if (tabId != null) {
      // 目标时间：默认本场次 hh:mm；若按钮提示了更晚的开抢时间则顺延到提示时间继续抢
      let targetTime = new Date(); targetTime.setHours(hh, mm, 0, 0);
      if (decOk && dec.btnTime) {
        const [bh, bm] = dec.btnTime.split(':').map(Number);
        const bt = new Date(); bt.setHours(bh, bm, 0, 0);
        if (bt.getTime() > targetTime.getTime() - 60000) targetTime = bt; // 按钮提示更晚→按提示时间抢
      }
      await startHalfClicking(tabId, targetTime.getTime()).catch(e => recordCrash('half', label, e));
      await refreshHalfSlots(tabId); // 抢完后趁页面新鲜，发现后续时段
    }
    setupAlarms();
    return;
  }
});

// v116.1: 设置变更实时重排闹钟 —— 不依赖 options 页面的 enableAlarms 消息(消息在 SW 回收窗口可能丢失/未达)。
// 只要 storage 里 hourlyEnabled 或时段配置变化，立即重新 setupAlarms，确保开关即时生效(已建的整点闹钟当场被清掉)。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // v129: 移除 halfSlots —— 它是内部「自适应发现」写入(值不变则不触发)，不应驱动 setupAlarms；
  // 真正需要重排时由心跳(每分钟)兜底。保留用户开关/时段配置的即时响应。
  if (changes.hourlyEnabled || changes.targetHour || changes.endHour) {
    setupAlarms();
  }
});

chrome.runtime.onMessage.addListener((req, sender, send) => {
  if (req.action === 'enableAlarms') {
    alarmsEnabled = true; setupAlarms();
    send({ ok: true, msg: '闹钟已启用' });
  }
  if (req.action === 'disableAlarms') {
    alarmsEnabled = false; chrome.alarms.clearAll();
    send({ ok: true, msg: '闹钟已禁用' });
  }
  // v130: 手动导出 raceLog 为 jd-racelog.json（替代原先每次轮次自动下载，避免弹"保存"框卡住）。
  // 仅用户在 options 页点「导出」时触发，此时下载是用户主动行为，Chrome 即便询问保存位置也只弹一次。
  if (req.action === 'exportRaceLog') {
    (async () => {
      await saveRaceLogToFile();   // 仅此处保留：用户主动点 options「导出」才下载，不再自动弹"保存"框
      send({ ok: true, msg: '已导出 jd-racelog.json' });
    })();
    return true;
  }
  if (req.action === 'forceClaim') {
    (async () => {
      const allTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const jdTab = allTabs.find(t => (t.url || '').includes(TARGET_URL) || (t.url || '').includes(HALF_TARGET_URL));
      if (jdTab) {
        if ((jdTab.url || '').includes(HALF_TARGET_URL)) startHalfClicking(jdTab.id, 0);
        else grabHourly(jdTab.id, 0);
        send({ ok: true, status: 'processing' });
      } else send({ ok: false, status: 'no_tab', msg: '请先在当前窗口激活京东领券页面' });
    })();
    return true;
  }
  // v113: 特价干跑 —— 只扫描不点击，用于验证识别是否准确（零下单风险）
  if (req.action === 'scanDealsNow') {
    (async () => {
      const cfg = await chrome.storage.local.get(['dealUrl', 'dealMaxPrice']);
      const maxPrice = Number(cfg.dealMaxPrice) > 0 ? Number(cfg.dealMaxPrice) : DEAL_MAX_PRICE;
      const frag = cfg.dealUrl || DEAL_URL;
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => { try { const u = new URL(x.url || ''); return (u.hostname + u.pathname).includes(frag); } catch (e) { return false; } });
      if (!t) { send({ ok: false, msg: '未找到特价活动页标签，请先打开：' + FULL_DEAL_URL }); return; }
      const list = await scanDeals(t.id, maxPrice);
      showNotification(`🔍 特价干跑：命中 ${list.length} 个`,
        list.length ? list.slice(0, 4).map(d => `[${d.tier}]¥${d.price} ${d.title.slice(0, 18)}`).join('\n')
                    : `当前页面没有 ≤${maxPrice} 的特价商品`);
      send({ ok: true, count: list.length, list });
    })();
    return true;
  }
});

// ===== 每轮结束后把 raceLog 保存到 ~/Downloads/jd-racelog.json 供外部读取 =====
// ===================== v113: 整点特价狙击（≤9.9 到手价商品）=====================
// 【判别依据】实测「天天半价」页：特价商品卡片带「到手价」标签且只有一个价格；
//   普通商品是「现价 + 原价 + N折」三段式，绝不出现「到手价」。故 A 档只认标签，最准。
// 【安全边界】只做"发现 → 抢先打开商品页 → 通知"，**绝不自动提交订单或支付**。
//   点击循环带 URL 逃逸 guard：页面一跳走立即停火，杜绝惯性点击打到「提交订单」。
function pageScanDeals(maxPrice) {
  const DONE = /已抢完|已售罄|已抢光|抢光|已结束|明日再来|已下架|敬请期待|已售完/;
  const COUPONISH = /满\s*\d+\s*(可用|减)/;              // 优惠券卡片(如 ¥7 满8可用)不是特价商品
  const LABEL = /^(到手价|秒杀价|抢购价|特价|限时价|补贴价)$/;
  const out = [], seen = new Set();

  const climb = (el) => {
    let c = el, d = 0;
    while (c && d < 10) {
      const cr = c.getBoundingClientRect();
      if (cr.width > 150 && cr.height > 100) return c;
      c = c.parentElement; d++;
    }
    return null;
  };

  const pushCard = (card, tier, label) => {
    if (!card) return;
    const r = card.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) return;
    const txt = (card.innerText || '').replace(/\s+/g, ' ').trim();
    if (!txt || DONE.test(txt)) return;
    if (tier === 'B' && COUPONISH.test(txt)) return;
    const nums = (txt.match(/¥\s*\d{1,4}(?:\.\d{1,2})?/g) || [])
      .map(s => parseFloat(s.replace(/[¥\s]/g, ''))).filter(v => v > 0);
    if (!nums.length) return;
    const price = Math.min.apply(null, nums);          // 到手价通常是卡片内最低价
    if (price > maxPrice) return;
    const absY = Math.round((window.scrollY || 0) + r.top + r.height / 2);
    const key = Math.round(r.left) + ',' + absY;
    if (seen.has(key)) return; seen.add(key);
    out.push({
      tier, label, price, title: txt.slice(0, 40),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
      absoluteY: absY, w: Math.round(r.width), h: Math.round(r.height)
    });
  };

  // A 档：带「到手价」等标签的特价卡（高可信）
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = tw.nextNode())) {
    const t = (n.nodeValue || '').trim();
    if (t.length <= 4 && LABEL.test(t)) pushCard(climb(n.parentElement), 'A', t);
  }
  // B 档兜底：页面改版丢了标签时，用"孤立低价数字"找卡（排除优惠券）
  if (!out.length) {
    const tw2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let m;
    while ((m = tw2.nextNode())) {
      const t = (m.nodeValue || '').trim();
      if (t.length > 8 || !/^¥?\s*\d{1,3}(?:\.\d{1,2})?$/.test(t)) continue;
      const v = parseFloat(t.replace(/[¥\s]/g, ''));
      if (v > 0 && v <= maxPrice) pushCard(climb(m.parentElement), 'B', '');
    }
  }
  out.sort((a, b) => (a.tier === b.tier) ? a.price - b.price : (a.tier === 'A' ? -1 : 1));
  return out.slice(0, 12);
}

async function scanDeals(tabId, maxPrice) {
  try {
    const r = await chrome.scripting.executeScript({ target: { tabId }, func: pageScanDeals, args: [maxPrice] });
    return r?.[0]?.result || [];
  } catch (e) { return []; }
}

async function grabDeals(targetTime) {
  const cfg = await chrome.storage.local.get(['dealEnabled', 'dealUrl', 'dealMaxPrice']);
  if (cfg.dealEnabled === false) return;
  const maxPrice = Number(cfg.dealMaxPrice) > 0 ? Number(cfg.dealMaxPrice) : DEAL_MAX_PRICE;
  const frag = cfg.dealUrl || DEAL_URL;
  const full = cfg.dealUrl ? ('https://' + String(cfg.dealUrl).replace(/^https?:\/\//, '')) : FULL_DEAL_URL;

  const log = { date: new Date(targetTime).toISOString().slice(0, 10), round: new Date(targetTime).toTimeString().slice(0, 8), type: 'deal', events: [], clicks: 0, firstClickOff: null };
  const stamp = (l) => {
    const o = Math.round(Date.now() - targetTime);
    log.events.push(`${l}@${o}ms`);
    console.log(`[特价] ${l} @${o}ms`);
    chrome.storage.local.set({ liveDeal: { round: log.round, at: Date.now(), events: log.events } }).catch(() => {});
  };
  const finish = async (outcome) => {
    log.outcome = outcome;
    try {
      const prev = (await chrome.storage.local.get('raceLog')).raceLog || [];
      prev.unshift(log);
      await chrome.storage.local.set({ raceLog: prev.slice(0, 30) });
      await sleep(1500);                               // 错开与整点领券的同名文件落盘
      // v130: 不再自动下载文件——避免 Chrome「下载前询问保存位置」时反复弹"保存"框卡住(用户 9/16 17:31 投诉"保存两次且停在保存页待确认")。
    // 数据已写入 chrome.storage.local.raceLog(上面 set)，options 页内联可见；需文件时由 options「导出」按钮手动触发。
    } catch (e) {}
  };

  stamp('start');
  const tabId = await getOrCreateTab(frag, full, '整点特价');
  if (tabId == null) { stamp('no-tab'); await finish('⚠️无特价标签'); return; }

  // v112 教训：绝不在 T0 刷新（页面重载会让 CDP 干等 ready，首火晚 4 秒）。只提前 8 秒刷一次。
  await sleepUntil(targetTime - 8000);
  stamp(await healOrReload(tabId, frag, full));
  await sleep(4200);                                    // 等渲染 + 懒加载
  const pre = await scanDeals(tabId, maxPrice);
  stamp('pre-scan:' + pre.length + (pre[0] ? `|min¥${pre[0].price}` : ''));

  await sleepUntil(targetTime);

  const isOffPage = async () => {
    try { const t = await chrome.tabs.get(tabId); return !((t.url || '').includes(frag)); }
    catch (e) { return true; }
  };
  // 安全闸：已经在交易/结算页就绝不点击
  try {
    const t0 = await chrome.tabs.get(tabId);
    if (/trade|settlement|payment|cashier|order/i.test(t0.url || '')) {
      stamp('ABORT-on-trade-page'); await finish('🛑已在交易页，主动放弃'); return;
    }
  } catch (e) {}

  let picked = null, clicks = 0;
  const deadline = targetTime + 20000;
  while (Date.now() < deadline && !picked) {
    const list = await scanDeals(tabId, maxPrice);
    if (list.length) {
      picked = list[0];
      stamp(`found:${list.length}|${picked.tier}|¥${picked.price}|${picked.title.slice(0, 18)}`);
      await scrollToY(tabId, picked.absoluteY);
      await sleep(160);
      const fresh = await scanDeals(tabId, maxPrice);
      const tgt = fresh.find(d => Math.abs(d.absoluteY - picked.absoluteY) < 80) || fresh[0] || picked;
      try { await chrome.debugger.attach({ tabId }, '1.3'); } catch (e) {}
      // 慢频点击(12/s)+URL 逃逸 guard：这是"打开商品页"，不是锤击领券，跳走即停
      clicks = await cdpClickLoop(tabId, tgt.x, tgt.y, 2500, 12,
        () => { log.firstClickOff = Math.round(Date.now() - targetTime); stamp('first-click'); }, isOffPage);
      try { await chrome.debugger.detach({ tabId }); } catch (e) {}
      break;
    }
    await sleep(400);
  }
  log.clicks = clicks;

  await sleep(1200);
  let endUrl = '';
  try { endUrl = (await chrome.tabs.get(tabId)).url || ''; } catch (e) {}
  const opened = !!endUrl && !endUrl.includes(frag);

  if (!picked) {
    stamp('none');
    await finish(`⬜无≤${maxPrice}特价(本轮未出现)`);
  } else if (opened) {
    stamp('OPENED:' + endUrl.slice(0, 60));
    try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}   // 需你手动下单，必须切前台
    try { const w = await chrome.tabs.get(tabId); chrome.windows.update(w.windowId, { focused: true }); } catch (e) {}
    showNotification('🔥 特价已打开，请手动下单',
      `¥${picked.price} ${picked.title.slice(0, 24)}\n已抢先打开商品页（不会自动付款），请立即确认下单`);
    await finish(`🔥已打开商品页 ¥${picked.price} ${picked.title.slice(0, 24)}`);
  } else {
    stamp('no-nav');
    showNotification('🟡 特价点击未跳转',
      `发现 ¥${picked.price} ${picked.title.slice(0, 20)}，点了 ${clicks} 次但页面没跳转，可能已被抢空`);
    await finish(`🟡点了${clicks}次未跳转 ¥${picked.price}`);
  }
}

async function saveRaceLogToFile() {
  try {
    const { raceLog } = await chrome.storage.local.get('raceLog');
    if (!raceLog || !raceLog.length) return;
    const json = JSON.stringify(raceLog, null, 2);
    const dataUrl = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    await chrome.downloads.download({ url: dataUrl, filename: 'jd-racelog.json', conflictAction: 'overwrite', saveAs: false });
  } catch (e) { console.log('[京东领券] 保存日志失败:', e.message); }
}

// ===== 辅助 =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function sleepUntil(targetMs) { const d = targetMs - Date.now(); return d > 0 ? sleep(d) : Promise.resolve(); }
function showNotification(title, msg) {
  try {
    // 若结果文本为空，给兜底文案，避免通知只剩标题
    const body = (msg && String(msg).trim()) ? String(msg) : '（无详细结果，请查看扩展选项页 → 领券记录/历史记录）';
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      title, message: body
    });
  } catch (e) { console.log('[通知]', title, msg); }
}

// v110+: 半点登录丢失持续提醒。与点击窗口并行运行，直到 T+70s。
// 检测到 plogin/passport 登录跳转 → 立即弹 🔴 通知；若用户迟迟未登录，每 15s 重复弹，避免错过。
// 页面回到 hour.jd.com → 打 LOGIN-RESTORED，本轮点击窗口（runScheduledClaim 已覆盖 T+60s）会自动接管续点。
async function watchLoginRedirect(tabId, targetTime, hstamp) {
  const end = targetTime + 70000;
  let lastNotified = 0, loggedOff = false;
  const isLoginPage = async () => {
    try { const t = await chrome.tabs.get(tabId); return /plogin|passport|login/i.test(new URL(t.url || '').hostname); }
    catch (e) { return false; }
  };
  while (Date.now() < end) {
    if (await isLoginPage()) {
      if (!loggedOff) { hstamp('LOGIN-REDIRECT'); loggedOff = true; }
      const now = Date.now();
      if (now - lastNotified > 15000) {
        lastNotified = now;
        showNotification('🔴 半点领券需要登录', '京东登录态丢失！请立即打开 hour.jd.com 登录，「登录后本轮会自动继续抢」。' + new Date().toLocaleTimeString());
      }
    } else if (loggedOff) {
      loggedOff = false;
      hstamp('LOGIN-RESTORED');
      showNotification('✅ 已恢复登录', '登录态恢复，本轮继续自动抢券');
    }
    await sleep(3000);
  }
}

// v99.8: 把标签页提到前台 + 弹通知 —— 扩展无法保证抢到时，让用户能手动补点。
// 半点窗口长达 1 小时，手动补点完全来得及；整点仅作"已运行"提醒。
// v107: 只在 T=0 附近瞬间把券 tab 提到前台(后台 tab 被节流不渲染/倒计时不翻牌)，T+backMs 后弹回原 tab。
// 用户策略：pop to the tab right before T=0, pop back T+1s —— 最小化抢焦点，只保证到点这一刻页面活跃。
async function popTabAroundT0(tabId, targetTime, leadMs, backMs) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const winId = tab.windowId;
    const prev = (await chrome.tabs.query({ active: true, windowId: winId }))[0];
    const prevId = prev && prev.id;
    await sleepUntil(targetTime - (leadMs || 500));
    try { await chrome.tabs.update(tabId, { active: true }); await chrome.windows.update(winId, { focused: true }); } catch (e) {}
    await sleepUntil(targetTime + (backMs || 1000));
    if (prevId && prevId !== tabId) { try { await chrome.tabs.update(prevId, { active: true }); } catch (e) {} }
  } catch (e) {}
}

async function focusTabForUser(tabId, title, msg) {
  try {
    const t = await chrome.tabs.get(tabId);
    try { await chrome.tabs.update(tabId, { active: true }); } catch (e) {}
    if (t && t.windowId != null) { try { await chrome.windows.update(t.windowId, { focused: true }); } catch (e) {} }
  } catch (e) {}
  if (title) showNotification(title, msg);
}

// ===== 等待页面就绪（SPA 轮询，最长 maxWaitMs） =====
async function waitForPageReady(tabId, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.readyState === 'complete' && document.querySelector('body') && (document.body.innerText || '').length > 0
      });
      if (r?.[0]?.result) return true;
    } catch(e) {}
    await sleep(500);
  }
  return false;
}
