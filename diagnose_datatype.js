// ============================================================
// 诊断脚本：检查页面上是否存在 data-type 属性
// 在 Chrome 控制台（F12）粘贴运行
// ============================================================

console.log("%c=== data-type 属性诊断 ===", "color:red;font-size:16px;font-weight:bold");

// 1. 检查所有 data-type 属性
const allWithDt = document.querySelectorAll('[data-type]');
console.log(`[1] 含 data-type 属性的元素: ${allWithDt.length} 个`);
if (allWithDt.length > 0) {
  allWithDt.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    const text = el.textContent.trim().substring(0, 40);
    console.log(`  [#${i}] <${el.tagName.toLowerCase()}> data-type="${el.getAttribute('data-type')}" ${Math.round(rect.width)}×${Math.round(rect.height)} "${text}"`);
  });
} else {
  console.log("  ❌ 页面上没有 data-type 属性！");
}

// 2. 检查 newBabelAwardCollection 链接
const awardLinks = document.querySelectorAll('a[href*="newBabelAwardCollection"]');
console.log(`\n[2] a[href*="newBabelAwardCollection"]: ${awardLinks.length} 个`);
awardLinks.forEach((el, i) => {
  const rect = el.getBoundingClientRect();
  console.log(`  [#${i}] ${Math.round(rect.width)}×${Math.round(rect.height)} ${el.href.substring(0,80)}`);
});

// 3. 检查含 "coupon" 的 class 或 href
const couponEls = document.querySelectorAll('a[class*="coupon"], a[href*="coupon"], a[href*="award"]');
console.log(`\n[3] a[class*="coupon"] 或 a[href*="coupon/award"]: ${couponEls.length} 个`);
couponEls.forEach((el, i) => {
  const rect = el.getBoundingClientRect();
  const text = el.textContent.trim().substring(0, 40);
  console.log(`  [#${i}] ${Math.round(rect.width)}×${Math.round(rect.height)} "${text}" href=${el.href.substring(0,60)}`);
});

// 4. 检查 "再来" 文字所在的可点击元素
console.log('\n[4] 含 "再来" 文字的可点击元素:');
const allEls = document.querySelectorAll('*');
let againCount = 0;
allEls.forEach(el => {
  const text = el.textContent || '';
  if (text.includes('再来') && (el.tagName === 'A' || window.getComputedStyle(el).cursor === 'pointer')) {
    const rect = el.getBoundingClientRect();
    if (rect.width > 50 && rect.height > 20) {
      console.log(`  <${el.tagName.toLowerCase()}> ${Math.round(rect.width)}×${Math.round(rect.height)} class="${el.className.substring(0,40)}" data-type="${el.getAttribute('data-type') || '(无)'}"`);
      if (againCount++ > 10) { console.log('  ... (更多，省略)'); return; }
    }
  }
});

// 5. 大图检查
console.log('\n[5] 大图检查 (w>1000, h>200):');
document.querySelectorAll('img').forEach((img, i) => {
  const rect = img.getBoundingClientRect();
  if (rect.width > 1000 && rect.height > 200) {
    console.log(`  [#${i}] IMG ${Math.round(rect.width)}×${Math.round(rect.height)}`);
    console.log(`    src=${img.src.substring(0,80)}`);
    console.log(`    data-type="${img.getAttribute('data-type') || '(无)'}"`);
    // 向上找可点击父元素
    let parent = img.parentElement;
    let depth = 0;
    while (parent && depth < 10) {
      const pRect = parent.getBoundingClientRect();
      const pStyle = window.getComputedStyle(parent);
      if ((parent.tagName === 'A' || pStyle.cursor === 'pointer') && pRect.width > 500) {
        console.log(`    -> 可点击父: <${parent.tagName.toLowerCase()}> ${Math.round(pRect.width)}×${Math.round(pRect.height)} cursor=${pStyle.cursor}`);
        if (parent.href) console.log(`       href=${parent.href.substring(0,80)}`);
        break;
      }
      parent = parent.parentElement;
      depth++;
    }
  }
});

// 6. 输出当前所有可见的大尺寸元素（用于对比 dumpDom）
console.log('\n[6] 页面上所有大尺寸可见元素 (w>200, h>50):');
const bigEls = [];
allEls.forEach(el => {
  try {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width > 200 && rect.height > 50 && style.display !== 'none' && style.visibility !== 'hidden') {
      bigEls.push({
        tag: el.tagName,
        cls: (el.className && typeof el.className === 'string') ? el.className.substring(0, 30) : '',
        dt: el.getAttribute('data-type') || '',
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        text: (el.textContent || '').trim().substring(0, 30)
      });
    }
  } catch(e) {}
});
bigEls.sort((a, b) => (b.w * b.h) - (a.w * a.h));
bigEls.slice(0, 20).forEach((d, i) => {
  console.log(`  [${i}] ${d.tag.toLowerCase()}.${d.cls} data-type="${d.dt}" ${d.w}×${d.h} "${d.text}"`);
});

console.log("\n%c=== 诊断完成 ===", "color:red;font-size:16px;font-weight:bold");
console.log("把以上输出复制发给开发者");
