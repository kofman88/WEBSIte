#!/usr/bin/env python3
"""M11 web app shell (frontend/app) — Playwright E2E against the contract stub.

Starts `node backend/tests/e2e/serve-stub.js <port>` (backend/utils/app-stub.js:
/api/app/* per miniapp/API.md + the M7 settings/all shape, the /api/auth slice,
static frontend/) and drives headless Chromium at 390×844 (phone) and 1280×900
(desktop) through:

  (a) /app/ without a token → login screen, no JS errors; wrong password → error
      text; correct → Home with the stats block and the plan badge
  (b) every tab (?tab=…) and every settings section (?sec=…) renders with no
      console errors and no «Раздел недоступен» placeholder; the D9
      «Расширенные настройки» screen renders the nested settings/all sections
      (levels.shared / long / short, smc.advanced, ptp, risk.advanced) as
      controls and saves a nested key with the nested body
  (c) a signal detail opens, browser Back closes it and stays in the app
  (d) a strategy switch sends POST /api/app/strategy with the Mini App body and
      re-renders; the Free LONG+SHORT mutex shows the bot's toast
  (e) POST settings/all with an out-of-range value → the bot's error toast
      («Недопустимое значение.»), the control reverts
  (f) ?demo=pro renders with no backend calls
  (g) an expired access token is refreshed transparently (one 401 → refresh →
      retry), a disabled account (403) lands on the login screen with the reason
  (h) logout returns to the login screen; session-only login uses sessionStorage

    python backend/tests/e2e/app.e2e.py [--port 3199] [--shots DIR] [--chromium /opt/pw-browsers/chromium]

Exit code 0 only when every check passed. Not part of `vitest run` (needs
Chromium + Playwright for Python); run it by hand or from CI.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SECTIONS = {"strategies": "Стратегии", "autotrade": "Авто-трейд", "risk": "Risk Management", "challenge": "Челлендж",
            "exchanges": "Биржи", "positions": "Позиции", "stats": "Статистика", "advanced": "Расширенные настройки",
            "plan": "Тариф", "help": "Помощь", "feedback": "Обратная связь", "lang": "Язык"}
TABS = {"home": ".promo", "signals": ".sig-list .sig", "analyze": ".an-form", "profile": ".user-card", "settings": ".tiles"}
VIEWPORTS = [("phone", 390, 844), ("desktop", 1280, 900)]


def wait_http(url, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("stub did not come up: " + url)


def post(url, data=None):
    req = urllib.request.Request(url, method="POST", data=json.dumps(data or {}).encode(), headers={"Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=5).read() or b"{}")


class Check:
    def __init__(self):
        self.failures, self.passed = [], 0

    def ok(self, cond, what):
        if cond:
            self.passed += 1
        else:
            self.failures.append(what)
            print("FAIL:", what, file=sys.stderr)


def run_viewport(p, base, name, width, height, shots, chk, chromium):
    launch = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
    if chromium and os.path.exists(chromium):
        launch["executable_path"] = chromium
    browser = p.chromium.launch(**launch)
    ctx = browser.new_context(viewport={"width": width, "height": height}, locale="ru-RU", device_scale_factor=2 if width < 600 else 1)
    page = ctx.new_page()
    errors, api_calls, posts = [], [], []
    page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
    # the browser logs every 401/403 as "Failed to load resource" — those are the expected
    # wrong-password / expired-token / disabled-account round trips, not app errors
    page.on("console", lambda m: errors.append("console.%s: %s" % (m.type, m.text))
            if m.type == "error" and not ("Failed to load resource" in m.text and ("401" in m.text or "403" in m.text)) else None)

    def on_request(r):
        if "/api/" in r.url:
            api_calls.append(r.url)
            if r.method == "POST":
                posts.append((r.url, r.post_data))
    page.on("request", on_request)

    def shot(n):
        page.screenshot(path=os.path.join(shots, "%s-%s.png" % (name, n)), full_page=True)

    def wait_toast(text, timeout=5000):
        # a previous toast may still be on screen: wait for one that carries the expected text
        page.wait_for_function("t => { const e = document.getElementById('toast'); return e && !e.hidden && e.textContent.indexOf(t) >= 0; }",
                               arg=text, timeout=timeout)
        return page.inner_text("#toast")

    def hide_toast():
        page.evaluate("() => { const e = document.getElementById('toast'); if (e) e.hidden = true; }")

    post(base + "/api/auth/__stub/reset")   # every viewport starts from the stub's initial per-user state

    def no_placeholder(where):
        txt = page.inner_text("#view")
        chk.ok("недоступен" not in txt.lower() and "раздел недоступен" not in txt.lower(), "%s/%s: no «недоступен» placeholder" % (name, where))

    def tag(what):
        return "%s: %s" % (name, what)

    # ---------------------------------------------------------------- (a) login
    page.goto(base + "/app/?splash=off")
    page.wait_for_selector("form.login-form", timeout=10000)
    chk.ok(page.locator(".h1", has_text="Вход").count() == 1, tag("a: login heading"))
    chk.ok(page.locator("#tabbar").is_hidden(), tag("a: tabbar hidden on the login screen"))
    chk.ok(page.locator("button", has_text="Войти через Telegram").count() == 1, tag("a: Telegram button (providers)"))
    chk.ok(not errors, tag("a: no JS errors on the login screen: %s" % errors[:3]))
    shot("01-login")
    page.fill("input[name=email]", "pro@chm.local")
    page.fill("input[name=password]", "wrong-pass")
    page.click("form.login-form button[type=submit]")
    page.wait_for_selector(".login-err", timeout=5000)
    chk.ok(page.inner_text(".login-err").strip() == "Неверный email или пароль.", tag("a: wrong password → error text"))
    chk.ok(page.locator("form.login-form").count() == 1, tag("a: still on the login screen"))
    page.fill("input[name=password]", "demo1234")
    page.click("form.login-form button[type=submit]")
    page.wait_for_selector(".promo", timeout=10000)
    page.wait_for_selector(".stats .stat", timeout=5000)
    chk.ok(page.locator(".stats .stat").count() == 3, tag("a: home stats block (3 cards)"))
    chk.ok(page.inner_text("#plan-badge") == "PRO", tag("a: plan badge PRO"))
    chk.ok(page.locator("#tabbar").is_visible(), tag("a: tabbar visible after login"))
    chk.ok(page.locator(".h2", has_text="Последние сигналы").count() == 1, tag("a: recent signals section"))
    tok = page.evaluate("localStorage.getItem('chm_access')")
    chk.ok(bool(tok), tag("a: access token stored (remember me)"))
    shot("02-home")

    # ---------------------------------------------------------------- (b) every tab + every section
    for tab, sel in TABS.items():
        page.goto(base + "/app/?splash=off&tab=" + tab)
        page.wait_for_selector(sel, timeout=10000)
        page.wait_for_selector("#view .sk", state="detached", timeout=10000)
        chk.ok(page.locator("form.login-form").count() == 0, tag("b: tab %s renders (no login)" % tab))
        no_placeholder("tab " + tab)
    shot("03-profile")
    for sec, title in SECTIONS.items():
        page.goto(base + "/app/?splash=off&sec=" + sec)
        page.wait_for_selector(".sub-head .h1", timeout=10000)
        page.wait_for_selector("#view .sk", state="detached", timeout=10000)
        chk.ok(page.inner_text(".sub-head .h1").strip().lower() == title.lower(), tag("b: section %s title" % sec))
        chk.ok(page.locator("#view .card").count() >= 1, tag("b: section %s renders cards" % sec))
        chk.ok(page.locator(".back", has_text="Настройки").count() == 1, tag("b: section %s in-page back" % sec))
        no_placeholder("sec " + sec)
        if sec in ("strategies", "advanced", "stats", "plan"):
            shot("04-sec-" + sec)
    # D9 screen: the nested M7 sections are real controls, not JSON blobs
    page.goto(base + "/app/?splash=off&sec=advanced")
    page.wait_for_selector(".group", timeout=10000)
    page.wait_for_selector("#view .sk", state="detached", timeout=10000)
    for g in ["Интерфейс", "Уровни — общие параметры", "Уровни — LONG", "Уровни — SHORT", "SMC — тонкие параметры",
              "Авто-трейд — дополнительно", "Partial TP", "Risk Management — дополнительно", "Уведомления — флаги"]:
        chk.ok(page.locator(".group .cond", has_text=g).count() >= 1, tag("b: advanced group «%s»" % g))
    chk.ok(page.locator("#view code").count() == 0, tag("b: advanced screen has no raw JSON blobs"))
    chk.ok(page.locator(".ctl-title", has_text="Пивоты: сила").count() >= 1, tag("b: preset label for levels.shared.pivot_strength"))
    chk.ok(page.locator(".ctl-title", has_text="Дни без торговли").count() == 1, tag("b: disabled_days control"))
    days = page.locator(".ctl:has(.ctl-title:has-text('Дни без торговли')) .seg-b")
    chk.ok(days.count() == 7 and days.nth(6).get_attribute("aria-pressed") == "true", tag("b: disabled_days = [Вс] from the stub"))
    over = page.locator(".ctl:has(.ctl-title:has-text('Переопределено'))")
    chk.ok(over.count() == 2 and "min_quality, zone_pct" in over.nth(1).inner_text(), tag("b: SHORT overrides listed"))
    chk.ok(page.locator("button", has_text="Сбросить все фильтры").count() == 1 and page.locator("button", has_text="Сбросить").count() >= 3, tag("b: reset actions"))
    # save a nested key: the body must be nested the same way
    posts.clear()
    page.locator(".group:has(.cond:has-text('Уровни — общие параметры')) .ctl:has(.ctl-title:has-text('Пивоты: сила')) .seg-b", has_text="10").click()
    chk.ok("Сохранено" in wait_toast("Сохранено"), tag("b: nested save toast"))
    body = [json.loads(d) for u, d in posts if u.endswith("/api/app/settings/all")]
    chk.ok(body == [{"levels": {"shared": {"pivot_strength": 10}}}], tag("b: nested settings/all body %s" % body))
    chk.ok(page.locator(".group:has(.cond:has-text('Уровни — общие параметры')) .ctl:has(.ctl-title:has-text('Пивоты: сила')) .seg-b.on").inner_text().strip() == "10", tag("b: nested value re-rendered"))
    # the short-direction «Сбросить» drops the overrides (server action, no optimistic value)
    posts.clear()
    hide_toast()
    page.locator(".group:has(.cond:has-text('Уровни — SHORT')) button", has_text="Сбросить").click()
    chk.ok("сброшены" in wait_toast("сброшены"), tag("b: direction reset toast"))
    chk.ok([json.loads(d) for u, d in posts if u.endswith("/api/app/settings/all")] == [{"levels": {"short": {"reset": True}}}], tag("b: reset body"))
    page.wait_for_timeout(300)
    chk.ok("— (как в общих" in page.locator(".ctl:has(.ctl-title:has-text('Переопределено'))").nth(1).inner_text(), tag("b: overrides cleared after reset"))
    shot("05-advanced")

    # ---------------------------------------------------------------- (c) detail + browser Back
    page.goto(base + "/app/?splash=off&tab=signals")
    page.wait_for_selector(".sig-list .sig", timeout=10000)
    n_before = page.evaluate("history.length")
    page.locator(".sig-list .sig").first.click()
    page.wait_for_selector("#detail .detail-title", timeout=5000)
    page.wait_for_selector("#detail canvas.chm-chart", timeout=8000)
    chk.ok(page.locator("#tabbar").is_hidden(), tag("c: tabbar hidden on the detail"))
    chk.ok(page.evaluate("history.length") == n_before + 1, tag("c: detail pushed one history entry"))
    shot("06-detail")
    page.go_back()
    page.wait_for_selector("#detail", state="hidden", timeout=5000)
    chk.ok("/app/" in page.url and page.locator(".sig-list .sig").count() > 0 and page.locator("form.login-form").count() == 0, tag("c: browser Back closed the detail and stayed in the app"))
    chk.ok(page.locator("#tabbar").is_visible(), tag("c: tabbar back after close"))

    # ---------------------------------------------------------------- (d) strategy switch → POST strategy
    page.click("#tabbar .tab[data-tab=profile]")
    page.wait_for_selector(".strat-card", timeout=10000)
    levels = page.locator(".strat-card").first
    chk.ok(not levels.evaluate("e => e.classList.contains('is-on')"), tag("d: LEVELS is off for the pro user before the toggle"))
    posts.clear()
    hide_toast()
    levels.locator(".sw.long input").click()
    toast_text = wait_toast("Уровни · LONG")
    sent = [json.loads(d) for u, d in posts if u.endswith("/api/app/strategy")]
    chk.ok(sent == [{"strategy": "LEVELS", "long": True, "short": False}], tag("d: POST strategy body %s" % sent))
    chk.ok("Уровни · LONG включён" in toast_text, tag("d: toggle toast"))
    page.wait_for_timeout(200)
    levels = page.locator(".strat-card").first
    chk.ok(levels.evaluate("e => e.classList.contains('is-on')") and levels.locator(".tag", has_text="В работе").count() == 1, tag("d: card re-rendered as running"))
    chk.ok(levels.locator(".sw.long input").is_checked(), tag("d: LONG switch stays on"))
    shot("07-profile")

    # ---------------------------------------------------------------- (e) out-of-range settings/all value
    page.goto(base + "/app/?splash=off&sec=strategies")
    page.wait_for_selector(".group .stepper", timeout=10000)
    page.wait_for_selector("#view .sk", state="detached", timeout=10000)
    quality = page.locator(".ctl:has(.ctl-title:has-text('Мин. качество'))").first
    before = quality.locator(".stepper b").inner_text().strip()
    state = {"rewritten": False}

    def rewrite(route):
        if route.request.method == "POST" and not state["rewritten"]:
            state["rewritten"] = True
            route.continue_(post_data=json.dumps({"levels": {"min_quality": 99}}))
        else:
            route.continue_()
    page.route("**/api/app/settings/all", rewrite)
    hide_toast()
    quality.locator(".step-b").nth(1).click()
    chk.ok(wait_toast("Недопустимое").strip() == "Недопустимое значение.", tag("e: bad_request → the bot's toast"))
    chk.ok(state["rewritten"], tag("e: the out-of-range body was sent"))
    page.wait_for_timeout(300)
    chk.ok(page.locator(".ctl:has(.ctl-title:has-text('Мин. качество'))").first.locator(".stepper b").inner_text().strip() == before, tag("e: value reverted to %s" % before))
    page.unroute("**/api/app/settings/all")
    shot("08-strategies")

    # ---------------------------------------------------------------- (g) expired token → one refresh; disabled → login
    api_calls.clear()
    post(base + "/api/auth/__stub/expire-access")
    page.goto(base + "/app/?splash=off&tab=signals")
    page.wait_for_selector(".sig-list .sig", timeout=10000)
    chk.ok(page.locator("form.login-form").count() == 0, tag("g: session kept after the expired token"))
    chk.ok(sum(1 for u in api_calls if "/api/auth/refresh" in u) == 1, tag("g: exactly one refresh call (single-flight)"))
    new_tok = page.evaluate("localStorage.getItem('chm_access')")
    chk.ok(new_tok and new_tok != tok, tag("g: access token rotated"))
    chk.ok(page.inner_text("#plan-badge") == "PRO", tag("g: still the same user"))

    # ---------------------------------------------------------------- (h) logout → login; session-only login
    page.click("#tabbar .tab[data-tab=profile]")
    page.wait_for_selector("button:has-text('Выйти')", timeout=5000)
    page.click("button:has-text('Выйти')")
    page.wait_for_selector("form.login-form", timeout=5000)
    chk.ok(page.evaluate("localStorage.getItem('chm_access')") is None and page.evaluate("localStorage.getItem('chm_refresh')") is None, tag("h: tokens cleared on logout"))
    chk.ok("Вы вышли из аккаунта." in page.inner_text("form.login-form"), tag("h: logout notice"))
    page.reload()
    page.wait_for_selector("form.login-form", timeout=8000)
    chk.ok(page.locator("#tabbar").is_hidden(), tag("h: reload stays on the login screen"))
    shot("09-logout")
    # Free user, remember-me off → sessionStorage; the Free CTA; the LONG+SHORT mutex toast
    page.fill("input[name=email]", "demo@chm.local")
    page.fill("input[name=password]", "demo1234")
    page.click("form.login-form .sw input")
    page.click("form.login-form button[type=submit]")
    page.wait_for_selector(".sig-list .sig", timeout=10000)   # the URL still deep-links ?tab=signals
    chk.ok(page.evaluate("sessionStorage.getItem('chm_access')") is not None and page.evaluate("localStorage.getItem('chm_access')") is None, tag("h: remember-me off → sessionStorage"))
    page.click("#tabbar .tab[data-tab=home]")
    page.wait_for_selector(".promo", timeout=8000)
    chk.ok(page.inner_text("#plan-badge") == "FREE", tag("h: FREE badge"))
    chk.ok(page.locator(".promo button", has_text="Оформить Pro").count() == 1, tag("h: Free promo CTA"))
    page.click("#tabbar .tab[data-tab=profile]")
    page.wait_for_selector(".strat-card", timeout=8000)
    posts.clear()
    hide_toast()
    page.locator(".strat-card").first.locator(".sw.short input").click()
    toast_text = wait_toast("LONG и SHORT")
    sent = [json.loads(d) for u, d in posts if u.endswith("/api/app/strategy")]
    chk.ok(sent == [{"strategy": "LEVELS", "long": True, "short": True}], tag("d: free mutex body %s" % sent))
    chk.ok(toast_text.strip() == "LONG и SHORT одновременно — доступно в Pro", tag("d: free mutex toast"))
    chk.ok(not page.locator(".strat-card").first.locator(".sw.short input").is_checked(), tag("d: SHORT switch reverted"))
    page.goto(base + "/app/?splash=off&sec=exchanges")
    page.wait_for_selector(".hint-card", timeout=8000)
    chk.ok("доступны в тарифе Pro" in page.inner_text("#view"), tag("b: Free exchanges gate"))
    shot("10-free-home")
    # disabled account → HTTP 403 in the envelope → login screen with the reason
    post(base + "/api/auth/__stub/disable", {"email": "demo@chm.local", "disabled": True})
    page.goto(base + "/app/?splash=off&tab=home")
    page.wait_for_selector("form.login-form", timeout=8000)
    chk.ok("Аккаунт заблокирован" in page.inner_text("form.login-form"), tag("g: disabled account → login screen with the reason"))
    post(base + "/api/auth/__stub/disable", {"email": "demo@chm.local", "disabled": False})

    # ---------------------------------------------------------------- (f) demo mode without a backend
    api_calls.clear()
    page.goto(base + "/app/?demo=pro&splash=off")
    page.wait_for_selector(".promo", timeout=8000)
    page.wait_for_selector("#view .sk", state="detached", timeout=10000)
    chk.ok(page.locator("#demo-badge").is_visible() and page.inner_text("#plan-badge") == "PRO", tag("f: demo=pro renders"))
    chk.ok(page.locator("form.login-form").count() == 0, tag("f: no login in demo mode"))
    chk.ok(not api_calls, tag("f: demo mode made no API calls"))
    shot("11-demo-pro")
    for variant in ["demo=1&tab=profile", "demo=empty", "demo=pro&sec=advanced", "demo=1&api=off&sec=plan"]:
        page.goto(base + "/app/?splash=off&" + variant)
        page.wait_for_selector("#view .card", timeout=8000)
        page.wait_for_selector("#view .sk", state="detached", timeout=10000)
        chk.ok(page.locator("form.login-form").count() == 0, tag("f: demo variant renders: " + variant))
    chk.ok(not api_calls, tag("f: demo variants made no API calls"))

    chk.ok(not errors, tag("no console/page errors: %s" % errors[:5]))
    browser.close()
    return page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chromium", default=os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium"))
    ap.add_argument("--shots", default=os.path.join(tempfile.gettempdir(), "chm-app-e2e"))
    ap.add_argument("--port", type=int, default=3199)
    args = ap.parse_args()
    os.makedirs(args.shots, exist_ok=True)
    base = "http://127.0.0.1:%d" % args.port
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", args.port))
    except OSError:
        print("port %d is busy — pass --port" % args.port, file=sys.stderr)
        sys.exit(2)
    finally:
        s.close()
    proc = subprocess.Popen(["node", os.path.join(ROOT, "backend", "tests", "e2e", "serve-stub.js"), str(args.port)],
                            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    chk = Check()
    pw = None
    try:
        wait_http(base + "/api/health")
        pw = sync_playwright().start()
        for name, w, hgt in VIEWPORTS:
            try:
                run_viewport(pw, base, name, w, hgt, args.shots, chk, args.chromium)
            except Exception as e:   # keep the other viewport running, report the failure
                chk.failures.append("%s: exception: %s" % (name, e))
                print("EXCEPTION in %s: %s" % (name, e), file=sys.stderr)
    finally:
        try:
            if pw:
                pw.stop()
        except Exception:
            pass
        proc.terminate()
        try:
            out = proc.communicate(timeout=5)[0]
        except Exception:
            out = b""
    print(json.dumps({"passed": chk.passed, "failures": chk.failures, "shots": args.shots}, ensure_ascii=False))
    if chk.failures:
        print(out.decode("utf-8", "replace")[-2000:], file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
