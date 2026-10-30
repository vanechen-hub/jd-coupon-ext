#!/bin/bash
# jd_grab.sh — local real-click grabber for JD coupons
# WHY THIS EXISTS: CDP/debugger clicks (the extension's approach) never fire JD's
# claim API (blocked by cactus.jd.com anti-bot). Only genuine OS-level clicks work.
# This script fires REAL CGEvent clicks via cliclick, scheduled by the OS, so it does
# not depend on the Claude session being awake.
#
# REQUIRES (one-time manual grants):
#   1. System Settings → Privacy & Security → Accessibility → enable Terminal
#      (or whichever app runs this). Without it, cliclick cannot click.
#   2. Chrome → View → Developer → "Allow JavaScript from Apple Events" (checked).
#      Lets this script read the live button position from the page.
#
# USAGE:
#   ./jd_grab.sh hourly     # 29-20 banner on pro.m.jd.com (flips in place, no reload)
#   ./jd_grab.sh half       # 5-4 coupon on hour.jd.com (reload so it lands at T=0)
#
# Intended to be launched ~2s before the target minute by launchd/at (see jd_grab.plist).

set -u
MODE="${1:-hourly}"
LOG=~/Downloads/jd-racelog-local.log
say() { echo "$(date '+%H:%M:%S') $*" | tee -a "$LOG"; }

# --- JS run in the front Chrome tab via AppleScript (needs Apple Events toggle) ---
chrome_js() {
  osascript -e "tell application \"Google Chrome\" to execute (front window's active tab) javascript \"$1\"" 2>&1
}

# --- Window bounds in screen points: x1 y1 x2 y2 ---
win_bounds() {
  osascript -e 'tell application "Google Chrome" to get bounds of front window' 2>&1 | tr ',' ' '
}

# Locate the target button, scroll it to viewport center, return "cssX cssY innerH text"
# CLAIMABLE excludes countdown ("16:00开抢"/"X:00再来") and done states.
locate_js='
(function(){
  var CLAIM=/立即领取|立即抢券|马上抢|立刻抢|领取/, TIME=/\\d{1,2}:\\d{2}/,
      DONE=/已抢光|已领取|已抢完|已结束|明日再来|去使用|敬请期待/;
  var sels="[data-type=coupon_text_button],.coupon-button-text,.coupon-button-wrap,.coupon-bu";
  var btns=[].slice.call(document.querySelectorAll(sels));
  var t=btns.filter(function(b){var x=(b.textContent||"").replace(/\\s+/g,"");
    return x&&!DONE.test(x)&&!TIME.test(x)&&CLAIM.test(x);})[0];
  if(!t){return "NONE|"+btns.map(function(b){return (b.textContent||"").replace(/\\s+/g,"").slice(0,8)}).join(",");}
  t.scrollIntoView({block:"center"});
  var r=t.getBoundingClientRect();
  return [Math.round(r.left+r.width/2),Math.round(r.top+r.height/2),window.innerHeight,(t.textContent||"").replace(/\\s+/g,"").slice(0,12)].join("|");
})();'

# reload for half mode so the page finishes loading right at T=0
if [ "$MODE" = "half" ]; then
  say "half: reloading page to land at T=0"
  chrome_js 'location.reload()' >/dev/null
  sleep 2   # SPA render
fi

say "MODE=$MODE — entering click window"
FIRED=0
END=$(( $(date +%s) + 60 ))   # try for up to 60s (half strategy = click 1 min)
while [ "$(date +%s)" -lt "$END" ]; do
  LOC=$(chrome_js "$locate_js")
  case "$LOC" in
    NONE*) sleep 0.4; continue;;
    ""|*error*) say "js-bridge-fail: $LOC (is 'Allow JavaScript from Apple Events' on?)"; sleep 0.5; continue;;
  esac
  IFS='|' read -r CX CY INNERH BTEXT <<< "$LOC"
  read -r X1 Y1 X2 Y2 <<< "$(win_bounds)"
  # content-area top on screen = window top + (window height - inner viewport height)
  CHROME_TOP=$(( (Y2 - Y1) - INNERH ))
  SX=$(( X1 + CX ))
  SY=$(( Y1 + CHROME_TOP + CY ))
  say "claimable \"$BTEXT\" css=($CX,$CY) -> screen=($SX,$SY); clicking"
  cliclick c:$SX,$SY
  FIRED=$((FIRED+1))
  sleep 0.8   # human pace between clicks
  # feedback: read the button's state right after the click (no injection needed).
  # A win/sold-out flips this text (已领取/已抢光/已抢完/去使用) or a toast appears.
  STATE=$(chrome_js '(function(){var s="[data-type=coupon_text_button],.coupon-button-text";var b=[].slice.call(document.querySelectorAll(s)).map(function(x){return (x.textContent||"").replace(/\\s+/g,"").slice(0,8)});var toast=(document.body.innerText.match(/领取成功|已抢光|已抢完|已领取|已结束|本时段优惠券已抢完[^。]*/)||[""])[0];return toast+"||"+b.slice(0,3).join(",");})();')
  say "STATE: $STATE"
  case "$STATE" in
    *领取成功*) say "WON — 领取成功"; break;;
    *已抢光*|*已抢完*|*已领取*) say "over — sold out/claimed"; break;;
  esac
done
say "done mode=$MODE clicks=$FIRED"
