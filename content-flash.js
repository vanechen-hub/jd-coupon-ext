// v106 debug: document_start observer to catch the coupon box that flashes on load then hides.
// Broadened: matches by CLASS (grab-coup/coupon/prize/redpacket) OR coupon text, logs add + attr
// (style/class) changes with computed visibility. Writes chrome.storage.local.flashLog + flashRan.
(function () {
  const T0 = Date.now();
  try { chrome.storage.local.set({ flashRan: new Date().toLocaleTimeString(), flashLog: [] }); } catch (e) {}
  const RE = /立即抢券|立即领取|马上抢|超补好运|好运券|满\d可用|抢券/;
  const CLS = /grab-coup|coupon|prize|redpacket|hongbao|lottery|award/i;
  const log = [];
  const push = (o) => { log.push(o); try { chrome.storage.local.set({ flashLog: log.slice(-100) }); } catch (e) {} };
  const rec = (action, el) => {
    try {
      if (!el || el.nodeType !== 1) return;
      const t = (el.textContent || '').replace(/\s+/g, '');
      const cls = String(el.className || '');
      const match = (t && t.length <= 40 && RE.test(t)) || CLS.test(cls);
      if (!match) return;
      const cs = getComputedStyle(el), r = el.getBoundingClientRect();
      push({ ms: Date.now() - T0, action, t: t.slice(0, 22), cls: cls.slice(0, 30), disp: cs.display, vis: cs.visibility, op: +cs.opacity, h: Math.round(r.height) });
    } catch (e) {}
  };
  const scan = (n) => { rec('add', n); if (n && n.nodeType === 1 && n.querySelectorAll) { try { n.querySelectorAll('[class*="grab"],[class*="coupon"],[class*="prize"],[class*="redpacket"]').forEach((d) => rec('add-desc', d)); } catch (e) {} } };
  const obs = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.addedNodes) m.addedNodes.forEach(scan);
      if (m.type === 'attributes') rec('attr:' + m.attributeName, m.target);
    }
  });
  try { obs.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] }); } catch (e) {}
})();
