// ============================================================
// 京东 pro.m.jd.com 按钮扫描脚本
// 使用方法：在 Chrome 控制台（F12）粘贴整个脚本，回车运行
// 把输出结果复制发给开发者
// ============================================================

console.log("%c=== 京东按钮扫描开始 ===", "color:red;font-size:16px;font-weight:bold");

const results = {
  timestamp: new Date().toLocaleString(),
  url: location.href,
  bigBanner: null,
  smallButtons: [],
  allClickables: []
};

// ============================================================
// 1. 扫描大 banner（整点券大图）
// ============================================================
console.log("\n%c[1] 扫描大 banner...", "color:blue;font-weight:bold");

// 方法A：找 a[href*="newBabelAwardCollection"]
const awardLinks = document.querySelectorAll('a[href*="newBabelAwardCollection"]');
if (awardLinks.length > 0) {
  console.log(`  ✅ 找到 ${awardLinks.length} 个 newBabelAwardCollection 链接`);
  awardLinks.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    console.log(`    [#${i}] ${Math.round(rect.width)}x${Math.round(rect.height)} | href=${el.href.substring(0,80)}`);
    if (rect.width > 500 && rect.height > 100) {
      results.bigBanner = {
        method: 'newBabelAwardCollection',
        tag: 'A',
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        href: el.href.substring(0, 100),
        selector: `a[href*="newBabelAwardCollection"]:nth-of-type(${i+1})`
      };
    }
  });
}

// 方法B：找大图片 (data-type="image", w>1000, h>200)
if (!results.bigBanner) {
  const bigImgs = document.querySelectorAll('img[data-type="image"]');
  console.log(`  [方法B] 找到 ${bigImgs.length} 个 img[data-type="image"]`);
  bigImgs.forEach((img, i) => {
    const rect = img.getBoundingClientRect();
    console.log(`    [#${i}] IMG ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    if (rect.width > 1000 && rect.height > 200) {
      console.log(`    -> 大图！向上找可点击父元素...`);
      let parent = img.parentElement;
      let depth = 0;
      while (parent && depth < 10) {
        const pRect = parent.getBoundingClientRect();
        const pStyle = window.getComputedStyle(parent);
        if (parent.tagName === 'A' && pRect.width > 500) {
          results.bigBanner = {
            method: 'image-parent-a',
            tag: 'A',
            x: Math.round(pRect.left + pRect.width / 2),
            y: Math.round(pRect.top + pRect.height / 2),
            w: Math.round(pRect.width),
            h: Math.round(pRect.height),
            href: parent.href ? parent.href.substring(0, 100) : '',
            selector: `a:has(img[data-type="image"])`
          };
          console.log(`    ✅ 找到可点击父 <A> ${results.bigBanner.w}x${results.bigBanner.h}`);
          break;
        }
        parent = parent.parentElement;
        depth++;
      }
    }
  });
}

// 方法C：找 data-type="view" 且宽度>700 的元素，再找可点击父元素
if (!results.bigBanner) {
  const views = document.querySelectorAll('[data-type="view"]');
  console.log(`  [方法C] 找到 ${views.length} 个 [data-type="view"]`);
  views.forEach((el, i) => {
    const rect = el.getBoundingClientRect();
    if (rect.width > 700 && rect.height > 200) {
      console.log(`    [#${i}] VIEW ${Math.round(rect.width)}x${Math.round(rect.height)} "11:00再来"`);
      let parent = el.parentElement;
      let depth = 0;
      while (parent && depth < 10) {
        const pRect = parent.getBoundingClientRect();
        const pStyle = window.getComputedStyle(parent);
        if ((parent.tagName === 'A' || pStyle.cursor === 'pointer') && pRect.width > 500) {
          results.bigBanner = {
            method: 'view-parent-clickable',
            tag: parent.tagName,
            x: Math.round(pRect.left + pRect.width / 2),
            y: Math.round(pRect.top + pRect.height / 2),
            w: Math.round(pRect.width),
            h: Math.round(pRect.height),
            href: parent.href ? parent.href.substring(0, 100) : '',
            selector: `${parent.tagName.toLowerCase()}:has([data-type="view"])`
          };
          console.log(`    ✅ 找到可点击父 <${parent.tagName}> ${results.bigBanner.w}x${results.bigBanner.h}`);
          break;
        }
        parent = parent.parentElement;
        depth++;
      }
    }
  });
}

if (results.bigBanner) {
  console.log("%c  ✅ 大banner定位成功!", "color:green;font-weight:bold");
  console.log(`     中心坐标: (${results.bigBanner.x}, ${results.bigBanner.y})`);
  console.log(`     尺寸: ${results.bigBanner.w}x${results.bigBanner.h}`);
} else {
  console.log("%c  ❌ 未找到大banner", "color:red;font-weight:bold");
}

// ============================================================
// 2. 扫描小按钮（coupon_text_button）
// ============================================================
console.log("\n%c[2] 扫描小按钮...", "color:blue;font-weight:bold");

const smallBtns = document.querySelectorAll('[data-type="coupon_text_button"]');
console.log(`  找到 ${smallBtns.length} 个 [data-type="coupon_text_button"]`);

smallBtns.forEach((el, i) => {
  const rect = el.getBoundingClientRect();
  const text = el.textContent.trim().substring(0, 30);
  
  // 判断是大banner内还是独立小按钮
  let isInBigBanner = false;
  let parent = el.parentElement;
  let depth = 0;
  while (parent && depth < 10) {
    const pRect = parent.getBoundingClientRect();
    if (pRect.width > 700) {
      isInBigBanner = true;
      break;
    }
    parent = parent.parentElement;
    depth++;
  }
  
  const btnInfo = {
    index: i,
    tag: el.tagName,
    x: Math.round(rect.left + rect.width / 2),
    y: Math.round(rect.top + rect.height / 2),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    text: text,
    isInBigBanner: isInBigBanner,
    isBig: isInBigBanner,
    selector: `[data-type="coupon_text_button"]:nth-of-type(${i+1})`
  };
  
  results.smallButtons.push(btnInfo);
  
  console.log(`    [#${i}] ${btnInfo.w}x${btnInfo.h} | isBig=${btnInfo.isBig} | "${text}"`);
  console.log(`        center=(${btnInfo.x}, ${btnInfo.y})`);
});

// ============================================================
// 3. 扫描 carousel-card（可能的小券卡片）
// ============================================================
console.log("\n%c[3] 扫描 carousel-card...", "color:blue;font-weight:bold");

const cards = document.querySelectorAll('[data-type="carousel-card"]');
console.log(`  找到 ${cards.length} 个 [data-type="carousel-card"]`);

cards.forEach((el, i) => {
  const rect = el.getBoundingClientRect();
  const text = el.textContent.trim().substring(0, 30);
  const style = window.getComputedStyle(el);
  
  console.log(`    [#${i}] ${Math.round(rect.width)}x${Math.round(rect.height)} | cursor=${style.cursor} | "${text}"`);
  
  // 检查是否可点击
  let clickable = style.cursor === 'pointer' || el.onclick || el.hasAttribute('onclick');
  let parent = el.parentElement;
  let depth = 0;
  while (parent && depth < 5 && !clickable) {
    const pStyle = window.getComputedStyle(parent);
    if (parent.tagName === 'A' || pStyle.cursor === 'pointer') {
      clickable = true;
      break;
    }
    parent = parent.parentElement;
    depth++;
  }
  
  if (clickable) {
    console.log(`    -> ✅ 可点击！`);
    results.allClickables.push({
      type: 'carousel-card',
      index: i,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      text: text
    });
  }
});

// ============================================================
// 4. 输出汇总
// ============================================================
console.log("\n%c=== 扫描汇总 ===", "color:red;font-size:16px;font-weight:bold");
console.log(`大banner: ${results.bigBanner ? '✅ 已定位' : '❌ 未找到'}`);
console.log(`小按钮(coupon_text_button): ${results.smallButtons.length} 个`);
console.log(`可点击卡片(carousel-card): ${results.allClickables.length} 个`);

console.log("\n%c=== 复制以下内容发给开发者 ===", "color:purple;font-weight:bold");
console.log(JSON.stringify(results, null, 2));

// 也输出可直接用于 debugger 点击的坐标列表
console.log("\n%c=== debugger 点击坐标（直接复制使用）===", "color:green;font-weight:bold");
if (results.bigBanner) {
  console.log(`大banner: x=${results.bigBanner.x}, y=${results.bigBanner.y}  // ${results.bigBanner.w}x${results.bigBanner.h}`);
}
results.smallButtons.forEach((btn, i) => {
  console.log(`小按钮${i+1}: x=${btn.x}, y=${btn.y}  // ${btn.w}x${btn.h} isBig=${btn.isBig} "${btn.text}"`);
});
results.allClickables.forEach((card, i) => {
  console.log(`卡片${i+1}: x=${card.x}, y=${card.y}  // ${card.w}x${card.h} "${card.text}"`);
});

console.log("%c=== 扫描完成 ===", "color:red;font-size:16px;font-weight:bold");
