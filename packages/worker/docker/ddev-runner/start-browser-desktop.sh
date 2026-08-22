#!/bin/bash
# Starts the headed-browser desktop inside the DDEV runner: Xvfb display, VNC
# server (the api bridges it to the web noVNC panel over the internal sandbox
# network — no password, never host-published), a socat forward exposing
# Chrome's CDP beyond localhost (headed Chrome only binds 127.0.0.1; the
# --remote-debugging-address flag is headless-only), and headed Chromium.
# Idempotent: pgrep guards make re-runs no-ops. Run as the `ddev` user.
#
# The privacy switches below are NOT cosmetic parity with puppeteer: this Chromium
# is launched RAW, so unlike browser-check.js (puppeteer.launch, which applies
# --disable-background-networking and friends as defaults) it inherits none of them,
# and the runner sits on the default bridge with unproxied internet. MEASURED with
# --log-net-log on Chromium 151 over 30s: an unflagged launch on about:blank issued
# requests to 7 Google hosts; the switches below remove optimizationguide-pa
# .googleapis.com (the only one keyed on browsing), the component-update downloads
# via redirector.gvt1.com, and clients2.google.com/time.
#
# Translate is disabled for the biggest payload rather than for anything observed in
# that window: it posts PAGE TEXT to translate.googleapis.com, and only fires on a
# foreign-language page, which a 30s about:blank capture cannot trigger. Same for the
# phishing classifier (page features) and breakpad (crash dumps carry process memory).
#
# Net effect MEASURED the same way: 7 Google hosts before, 3 after, with CDP still
# serving and navigation unaffected.
#
# Also MEASURED, and the reason this stops at switches: navigating to a real page added
# NO further Google traffic, so the visited URL does not leak. The 3 that remain carry
# no project URL or content -- accounts.google.com/ListAccounts (empty on a signed-out
# profile), android.clients.google.com checkin/register3 (GCM device registration), and
# a www.google.com new-tab/search prefetch. None answers to a command-line switch:
# --allow-browser-signin=false was tried and left ListAccounts untouched. An
# /etc/chromium/policies/managed file DOES remove the www.google.com pair (verified via
# DefaultSearchProviderEnabled + NewTabPageLocation) but not the other two, and it is a
# separate change because this script runs as `ddev` and cannot write /etc, so both the
# image and the app-runner injection path would need it wired.
#
# --disable-background-networking is kept as the documented umbrella even though it
# removed nothing measurable on its own here.
#
# The three --disable-*background*/renderer-backgrounding switches are a different
# concern from the privacy set, and they are here for the same raw-launch reason:
# puppeteer applies them by default, this launch inherits nothing. Agents now open a
# tab EACH (see BROWSER_TAB_DISCIPLINE in sandbox/mcp-surface.ts) because they share
# this one browser, so at any moment all but one agent's tab is in the background.
# Without these, Chrome throttles those tabs' timers and lowers their renderer
# priority, and an agent's wait against a timer-driven UI then fails for a reason that
# has nothing to do with the app under test. Only ONE tab is painted either way --
# these change scheduling, not visibility.
set -u

DISPLAY_NUM=":99"
VNC_PORT=5900
CDP_LOCAL=9222
CDP_PUBLIC=9223

if ! pgrep -x Xvfb >/dev/null 2>&1; then
  Xvfb "$DISPLAY_NUM" -screen 0 1920x1080x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  sleep 1
fi

if ! pgrep -x x11vnc >/dev/null 2>&1; then
  # -nomodtweak: keep the client-held modifier state instead of synthesizing it
  # per keysym. Default -modtweak releases a held Shift to produce the unshifted
  # XK_Tab, so Shift+Tab reaches Chromium as plain Tab (focus jumps forward, not
  # back). -nomodtweak presses the keycode under the live Shift, so Shift+Tab,
  # capitals and shifted symbols all arrive correctly. (-xkb does NOT fix this.)
  x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -forever -shared -nopw -nomodtweak \
    -quiet -bg -o /tmp/x11vnc.log >/dev/null 2>&1
fi

if ! pgrep -f "socat.*${CDP_PUBLIC}" >/dev/null 2>&1; then
  nohup socat "TCP-LISTEN:${CDP_PUBLIC},fork,reuseaddr" "TCP:127.0.0.1:${CDP_LOCAL}" \
    >/tmp/socat-cdp.log 2>&1 &
fi

if ! pgrep -f "chromium.*remote-debugging-port=${CDP_LOCAL}" >/dev/null 2>&1; then
  DISPLAY="$DISPLAY_NUM" nohup chromium \
    --no-first-run \
    --no-default-browser-check \
    --disable-session-crashed-bubble \
    --disable-infobars \
    --test-type \
    --ignore-certificate-errors \
    --password-store=basic \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --disable-background-networking \
    --disable-component-update \
    --disable-domain-reliability \
    --disable-breakpad \
    --disable-crash-reporter \
    --disable-client-side-phishing-detection \
    --disable-sync \
    --metrics-recording-only \
    --no-pings \
    --safebrowsing-disable-auto-update \
    --disable-features=Translate,OptimizationHints,NetworkTimeServiceQuerying \
    --remote-debugging-port="${CDP_LOCAL}" \
    --user-data-dir="${CHROME_PROFILE_DIR:-$HOME/.chrome-profile}" \
    --window-size=1920,1080 \
    --start-maximized \
    about:blank >/tmp/chromium.log 2>&1 &
fi

# Wait for the CDP endpoint so callers can connect immediately after we return.
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${CDP_LOCAL}/json/version" >/dev/null 2>&1; then
    echo "browser desktop ready (display ${DISPLAY_NUM}, vnc ${VNC_PORT}, cdp ${CDP_PUBLIC})"
    exit 0
  fi
  sleep 1
done
echo "browser desktop failed to expose CDP within 30s" >&2
exit 1
