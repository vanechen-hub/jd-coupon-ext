    const EXT_URL = '';

    async function loadSettings() {
      const data = await chrome.storage.local.get(['targetHour', 'endHour', 'notifyEnabled', 'history', 'targetBanner', 'targetCoupons', 'targetCoupon', 'hourlyEnabled']);
      document.getElementById('startHour').value = data.targetHour ?? 8;
      document.getElementById('endHour').value = data.endHour ?? 23;
      document.getElementById('hourlyEnabled').checked = data.hourlyEnabled !== false;
      document.getElementById('notifyEnabled').checked = data.notifyEnabled !== false;
      document.getElementById('targetBanner').value = data.targetBanner ?? '29-20';
      // 兼容旧的单个 targetCoupon
      let coupons = Array.isArray(data.targetCoupons) ? data.targetCoupons
                  : (data.targetCoupon ? [data.targetCoupon] : ['10', '4-3']);
      document.getElementById('targetCoupons').value = coupons.join(', ');
      renderHistory(data.history || []);
      const rl = await chrome.storage.local.get('raceLog');
      renderRaceLog(rl.raceLog || []);
    }

    function renderRaceLog(logs) {
      const el = document.getElementById('raceLog');
      if (!logs.length) { el.textContent = '暂无记录'; return; }
      el.innerHTML = logs.map(l => {
        const head = `<b>${l.round}</b> → ${l.outcome || '?'} <span style="color:#999">(首击@${l.firstClickOff}ms, ${l.clicks}次)</span>`;
        const ev = (l.events || []).join('  ·  ');
        return `<div style="padding:8px 0;border-bottom:1px solid #eee;">${head}<div style="color:#888;margin-top:4px;">${ev}</div></div>`;
      }).join('');
    }

    async function saveSettings() {
      try {
        const startHour = parseInt(document.getElementById('startHour').value);
        const endHour = parseInt(document.getElementById('endHour').value);
        const targetBanner = document.getElementById('targetBanner').value.trim();
        const targetCoupons = document.getElementById('targetCoupons').value
          .split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const hourlyEnabled = document.getElementById('hourlyEnabled').checked;
        await chrome.storage.local.set({ targetHour: startHour, endHour, targetBanner, targetCoupons, hourlyEnabled });
        // 回读确认确实写进去了
        const saved = (await chrome.storage.local.get('hourlyEnabled')).hourlyEnabled;
        showStatus('设置已保存：整点=' + (saved ? '开' : '关') + '；大Banner ' + targetBanner + '；小券 ' + targetCoupons.join(' / '), 'success');
        // 通知 background 重新配置闹钟
        try { chrome.runtime.sendMessage({ action: 'enableAlarms' }); } catch (e) {}
      } catch (e) {
        showStatus('保存失败：' + e.message, 'error');
      }
    }

    async function testClaim() {
      showStatus('正在打开领券页面...', '');
      chrome.runtime.sendMessage({ action: 'forceClaim' }, (res) => {
        if (res && res.ok) {
          showStatus('已触发领券测试，正在点击当前活动的京东领券页', 'success');
        } else {
          showStatus('测试失败: ' + (res ? res.msg : '未知错误'), 'error');
        }
      });
    }

    function renderHistory(history) {
      const tbody = document.getElementById('historyTable');
      if (!history.length) {
        tbody.innerHTML = '<tr><td colspan="2" style="color:#999;text-align:center;">暂无记录</td></tr>';
        return;
      }
      tbody.innerHTML = history.slice(0, 20).map(r =>
        `<tr><td class="time">${r.time}</td><td>${r.result}</td></tr>`
      ).join('');
    }

    function showStatus(msg, type) {
      const el = document.getElementById('status');
      el.textContent = msg;
      el.className = type;
    }

    async function exportRaceLog() {
      const status = document.getElementById('exportStatus');
      status.textContent = '导出中…';
      try {
        chrome.runtime.sendMessage({ action: 'exportRaceLog' }, (res) => {
          status.textContent = (res && res.ok) ? '✅ 已导出 jd-racelog.json' : ('❌ ' + (res ? res.msg : '导出失败'));
          setTimeout(() => { status.textContent = ''; }, 4000);
        });
      } catch (e) { status.textContent = '❌ ' + e.message; }
    }

    async function copyRaceLog() {
      const status = document.getElementById('exportStatus');
      try {
        const rl = await chrome.storage.local.get('raceLog');
        await navigator.clipboard.writeText(JSON.stringify(rl.raceLog || [], null, 2));
        status.textContent = '✅ 已复制 JSON 到剪贴板';
      } catch (e) { status.textContent = '❌ 复制失败：' + e.message; }
      setTimeout(() => { status.textContent = ''; }, 4000);
    }

    loadSettings();
    // MV3 默认 CSP(script-src 'self') 会拦截内联 <script> 与内联 onclick 句柄。
    // 必须改用外部 options.js 通过 <script src> 加载，脚本才会真正执行。
    document.getElementById('saveBtn').addEventListener('click', saveSettings);
    document.getElementById('testBtn').addEventListener('click', testClaim);
    document.getElementById('exportBtn').addEventListener('click', exportRaceLog);
    document.getElementById('copyBtn').addEventListener('click', copyRaceLog);
