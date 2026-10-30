// 京东整点领券助手 - content.js
// 整点时高速点击领券按钮

(function() {
  'use strict';

  console.log('[京东领券] 内容脚本启动');

  // 整点点击逻辑
  function waitUntilTopOfHour() {
    return new Promise((resolve) => {
      const now = new Date();
      const msUntilTop = (60 - now.getMinutes()) * 60 * 1000 - now.getSeconds() * 1000 - now.getMilliseconds();
      console.log(`[京东领券] 距离整点还有 ${Math.round(msUntilTop/1000)} 秒`);
      setTimeout(resolve, msUntilTop);
    });
  }

  async function startClicking() {
    console.log('[京东领券] 开始整点点击');

    // 先刷新一下页面，确保是最新的券状态
    console.log('[京东领券] 刷新页面...');
    location.reload();
    await new Promise(r => setTimeout(r, 3000));

    const startTime = Date.now();
    const maxDuration = 20000; // 最多点击20秒
    let clickCount = 0;

    while (Date.now() - startTime < maxDuration) {
      // 多种按钮选择器
      const selectors = [
        'button:has-text("领券")',
        'button:has-text("立即领取")',
        'button:has-text("立即抢")',
        '.btn-coupon',
        '[class*="coupon"] button',
        'a:has-text("领券")',
        '[class*="award"] button',
        '.J_getCoupon',
        '#J_getCoupon',
        'button[data-type="get"]'
      ];

      let clicked = false;
      for (const sel of selectors) {
        try {
          const btns = document.querySelectorAll(sel);
          for (const btn of btns) {
            const text = btn.textContent?.trim() || '';
            // 跳过已领取相关的按钮
            if (text.includes('已领取') || text.includes('明日再来') || 
                text.includes('已抢光') || text.includes('已结束')) {
              continue;
            }
            
            console.log(`[京东领券] 点击按钮: ${text}`);
            btn.click();
            clickCount++;
            clicked = true;
            break;
          }
        } catch(e) {}
        if (clicked) break;
      }

      // 检查是否有成功的弹窗
      const successTexts = ['领取成功', '恭喜', '已领取', '领取成功'];
      const bodyText = document.body.textContent || '';
      for (const t of successTexts) {
        if (bodyText.includes(t)) {
          console.log(`[京东领券] ✓ 领取成功！`);
          notifyBackground('success', `点击${clickCount}次，领取成功！`);
          return;
        }
      }

      await sleep(100);
    }

    console.log(`[京东领券] 完成，点击了 ${clickCount} 次`);
    notifyBackground('done', `点击了 ${clickCount} 次，未检测到成功标志`);
  }

  function notifyBackground(status, message) {
    chrome.runtime.sendMessage({ action: 'claimResult', status, message });
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // 主流程
  async function main() {
    // 等待整点
    await waitUntilTopOfHour();
    console.log('[京东领券] 整点到！开始点击');
    
    // 整点后高速点击
    await startClicking();
  }

  // 立即启动
  main().catch(e => console.error('[京东领券] 错误:', e));
})();