#!/bin/bash
# Starts the headed-browser desktop inside the DDEV runner: Xvfb display, VNC
# server (the api bridges it to the web noVNC panel over the internal sandbox
# network — no password, never host-published), a socat forward exposing
# Chrome's CDP beyond localhost (headed Chrome only binds 127.0.0.1; the
# --remote-debugging-address flag is headless-only), and headed Chromium.
# Idempotent: pgrep guards make re-runs no-ops. Run as the `ddev` user.
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
