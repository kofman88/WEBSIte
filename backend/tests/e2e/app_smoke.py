#!/usr/bin/env python3
"""Playwright smoke of the web app shell (frontend/app) against the contract stub.

Starts `node backend/tests/e2e/serve-stub.js <port>` and drives headless
Chromium through: login screen (JWT) → Home → Signals → signal detail →
browser Back closes it → Profile → settings root → section → in-page «Назад»
→ 401 refresh flow → logout → login screen; plus the `?demo=pro` mock mode
with no backend calls. Screenshots go to --shots (default: a temp dir).

    python backend/tests/e2e/app_smoke.py [--chromium /opt/pw-browsers/chromium] [--shots DIR]

Not part of `vitest run` (needs Chromium); run it by hand or from CI with
Playwright installed.
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


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_http(url, timeout=20):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            urllib.request.urlopen(url, timeout=2).read()
            return
        except Exception:
            time.sleep(0.2)
    raise RuntimeError("stub did not come up: " + url)


class Check:
    def __init__(self):
        self.failures = []
        self.passed = 0

    def ok(self, cond, what):
        if cond:
            self.passed += 1
        else:
            self.failures.append(what)
            print("FAIL:", what, file=sys.stderr)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--chromium", default=os.environ.get("CHROMIUM", "/opt/pw-browsers/chromium"))
    ap.add_argument("--shots", default=os.path.join(tempfile.gettempdir(), "chm-app-smoke"))
    ap.add_argument("--port", type=int, default=0)
    args = ap.parse_args()
    os.makedirs(args.shots, exist_ok=True)
    port = args.port or free_port()
    base = f"http://127.0.0.1:{port}"
    proc = subprocess.Popen(["node", os.path.join(ROOT, "backend", "tests", "e2e", "serve-stub.js"), str(port)],
                            cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    chk = Check()
    pw = page = None
    errors, api_calls = [], []
    try:
        wait_http(base + "/api/health")
        pw = sync_playwright().start()
        p = pw
        launch = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if args.chromium and os.path.exists(args.chromium):
            launch["executable_path"] = args.chromium
        browser = p.chromium.launch(**launch)
        ctx = browser.new_context(viewport={"width": 414, "height": 896}, locale="ru-RU", device_scale_factor=2)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
        # the browser logs every 401 as "Failed to load resource" — those are the expected
        # wrong-password / expired-token round trips, not app errors
        page.on("console", lambda m: errors.append("console.%s: %s" % (m.type, m.text))
                if m.type == "error" and not ("Failed to load resource" in m.text and "401" in m.text) else None)
        page.on("request", lambda r: api_calls.append(r.url) if "/api/" in r.url else None)

        def shot(name):
            page.screenshot(path=os.path.join(args.shots, name + ".png"), full_page=True)

        # 1. no session → login screen, tab bar hidden
        page.goto(base + "/app/?splash=off")
        page.wait_for_selector("form.login-form", timeout=10000)
        chk.ok(page.locator(".h1", has_text="Вход").count() == 1, "login heading")
        chk.ok(page.locator("#tabbar").is_hidden(), "tabbar hidden on login")
        chk.ok(page.locator("button", has_text="Войти через Telegram").count() == 1, "telegram button from providers")
        chk.ok(page.locator("button", has_text="Зарегистрироваться").count() == 1, "register button")
        shot("01-login")

        # wrong password → error text, still on the login screen
        page.fill("input[name=email]", "demo@chm.local")
        page.fill("input[name=password]", "wrong")
        page.click("form.login-form button[type=submit]")
        page.wait_for_selector(".login-err", timeout=5000)
        chk.ok("Неверный email или пароль" in page.inner_text(".login-err"), "invalid credentials text")

        # register mode toggles and back
        page.click("button:has-text('Зарегистрироваться')")
        page.wait_for_selector(".h1:has-text('Регистрация')")
        page.click("button:has-text('У меня есть аккаунт — войти')")
        page.wait_for_selector(".h1:has-text('Вход')")

        # 2. 2FA account → code step
        page.fill("input[name=email]", "2fa@chm.local")
        page.fill("input[name=password]", "demo1234")
        page.click("form.login-form button[type=submit]")
        page.wait_for_selector(".h1:has-text('Код подтверждения')", timeout=5000)
        shot("02-2fa")
        page.click("button:has-text('Назад')")
        page.wait_for_selector(".h1:has-text('Вход')")

        # 3. real login → Home renders the Mini App blocks
        page.fill("input[name=email]", "pro@chm.local")
        page.fill("input[name=password]", "demo1234")
        page.click("form.login-form button[type=submit]")
        page.wait_for_selector(".promo", timeout=10000)
        page.wait_for_selector(".mtrend", timeout=5000)
        chk.ok(page.locator("#tabbar").is_visible(), "tabbar visible after login")
        chk.ok(page.inner_text("#plan-badge") == "PRO", "plan badge PRO")
        chk.ok(page.locator(".stats .stat").count() == 3, "stats block")
        chk.ok(page.locator(".h2", has_text="Стратегии").count() >= 1, "strategies section")
        chk.ok(page.locator(".h2", has_text="Последние сигналы").count() == 1, "recent signals section")
        tok = page.evaluate("localStorage.getItem('chm_access')")
        chk.ok(bool(tok) and tok.startswith("acc."), "jwt stored in localStorage (remember me)")
        shot("03-home")

        # 4. Signals tab → detail → browser Back closes it
        page.click("#tabbar .tab[data-tab=signals]")
        page.wait_for_selector(".sig-list .sig", timeout=5000)
        chk.ok(page.locator(".sumbar").count() == 1, "signals summary bar")
        n_before = page.evaluate("history.length")
        page.locator(".sig-list .sig").first.click()
        page.wait_for_selector("#detail .detail-title", timeout=5000)
        chk.ok(page.locator("#detail .back", has_text="Назад").is_visible(), "in-page back button on detail")
        chk.ok(page.locator("#tabbar").is_hidden(), "tabbar hidden on detail")
        page.wait_for_selector("#detail canvas.chm-chart", timeout=8000)
        chk.ok(page.locator("#detail .timeline").count() == 1, "timeline")
        chk.ok(page.locator("#detail .ladder").count() == 1, "ladder")
        chk.ok(page.locator("#detail .manual").count() == 1, "manual result card")
        chk.ok(page.locator("#detail button", has_text="Открыть в боте").count() == 0, "no 'Открыть в боте'")
        chk.ok(page.evaluate("history.length") == n_before + 1, "detail pushed a history entry")
        shot("04-detail")
        page.go_back()
        page.wait_for_selector("#detail", state="hidden", timeout=5000)
        chk.ok(page.locator(".sig-list .sig").count() > 0, "back closed the detail and restored the list")
        # open again, close with the in-page button (history.back)
        page.locator(".sig-list .sig").first.click()
        page.wait_for_selector("#detail .detail-title")
        page.click("#detail .back")
        page.wait_for_selector("#detail", state="hidden", timeout=5000)
        chk.ok(page.evaluate("history.length") == n_before + 1, "in-page back used history.back()")
        # Escape also closes
        page.locator(".sig-list .sig").first.click()
        page.wait_for_selector("#detail .detail-title")
        page.keyboard.press("Escape")
        page.wait_for_selector("#detail", state="hidden", timeout=5000)

        # 5. Analyze tab
        page.click("#tabbar .tab[data-tab=analyze]")
        page.wait_for_selector(".an-form input", timeout=5000)
        page.fill(".an-form input", "sol")
        page.click(".an-form button.btn-red")
        page.wait_for_selector(".result .coin-head", timeout=15000)
        chk.ok("SOL/USDT" in page.inner_text(".result .coin-head"), "analyze result head")
        chk.ok(page.locator(".result canvas.chm-chart").count() == 1, "analyze canvas chart")
        shot("05-analyze")

        # 6. Profile → settings root → section → in-page back chain
        page.click("#tabbar .tab[data-tab=profile]")
        page.wait_for_selector(".user-card", timeout=5000)
        chk.ok(page.locator("button", has_text="Выйти").count() == 1, "logout button in profile")
        chk.ok(page.locator("button", has_text="Открыть бота").count() == 0, "no 'Открыть бота'")
        chk.ok(page.locator("a", has_text="Аккаунт и безопасность").count() == 1, "account link")
        page.wait_for_selector(".genome", timeout=5000)
        shot("06-profile")
        page.click("button.btn:has-text('Все настройки')")
        page.wait_for_selector(".tiles", timeout=5000)
        chk.ok(page.locator(".back", has_text="Профиль").count() == 1, "settings root back label")
        chk.ok(page.locator(".tile", has_text="Расширенные настройки").count() == 1, "advanced tile")
        page.click(".tile:has-text('Стратегии')")
        page.wait_for_selector(".group .stepper", timeout=5000)
        chk.ok(page.locator(".back", has_text="Настройки").count() == 1, "section back label")
        shot("07-strategies")
        # stepper → optimistic save → toast «Сохранено»
        page.locator(".stepper .step-b").nth(1).click()
        page.wait_for_selector("#toast:not([hidden])", timeout=5000)
        chk.ok("Сохранено" in page.inner_text("#toast"), "stepper save toast")
        page.click(".back")
        page.wait_for_selector(".tiles", timeout=5000)
        page.click(".tile:has-text('Расширенные настройки')")
        page.wait_for_selector(".group", timeout=5000)
        chk.ok(page.locator(".ctl-title", has_text="Пивоты: сила").count() == 1, "D9 preset control rendered")
        chk.ok(page.locator(".ctl-title", has_text="Режим меню").count() == 1, "ui_mode control")
        shot("08-advanced")
        page.click(".back")
        page.wait_for_selector(".tiles")
        page.click(".tile:has-text('Тариф')")
        page.wait_for_selector(".plan", timeout=5000)
        chk.ok(page.locator("button", has_text="Продлить Pro").count() >= 1, "plan checkout button")
        chk.ok("TON" not in page.inner_text("#view"), "no TON block")
        shot("09-plan")
        page.go_back()
        page.wait_for_selector(".tiles", timeout=5000)
        page.go_back()
        page.wait_for_selector(".user-card", timeout=5000)
        chk.ok(page.locator(".tiles").count() == 1 and page.locator(".back").count() == 0, "browser back returned to profile root")

        # 7. deep link to a section, in-page back without history entries of ours
        page.goto(base + "/app/?splash=off&sec=help")
        page.wait_for_selector(".help-acc", timeout=8000)
        chk.ok(page.locator(".acc-i").count() == 11, "help accordion 11 sections")
        page.click(".back")
        page.wait_for_selector(".tiles", timeout=5000)
        page.click(".back")
        page.wait_for_selector(".user-card", timeout=5000)

        # 7b. every settings section renders from its deep link (no skeleton left, no errors)
        SECTIONS = {"strategies": "Стратегии", "autotrade": "Авто-трейд", "risk": "Risk Management", "challenge": "Челлендж",
                    "exchanges": "Биржи", "positions": "Позиции", "stats": "Статистика", "advanced": "Расширенные настройки",
                    "plan": "Тариф", "help": "Помощь", "feedback": "Обратная связь", "lang": "Язык"}
        for sec, title in SECTIONS.items():
            page.goto(base + "/app/?splash=off&sec=" + sec)
            page.wait_for_selector(".sub-head .h1", timeout=8000)
            page.wait_for_selector("#view .sk", state="detached", timeout=10000)
            chk.ok(page.inner_text(".sub-head .h1").strip().lower() == title.lower(), "section %s title" % sec)
            chk.ok(page.locator("#view .card").count() >= 1, "section %s renders cards" % sec)
        # challenge: questionnaire → «Посчитать план» → plan card (pro user)
        page.goto(base + "/app/?splash=off&sec=challenge")
        page.wait_for_selector("button:has-text('Посчитать план')", timeout=8000)
        page.click("button:has-text('Посчитать план')")
        page.wait_for_selector(".group:has-text('План')", timeout=8000)
        chk.ok(page.locator(".kv", has_text="Заработать").count() == 1, "challenge plan card")
        shot("07b-challenge")
        # feedback: validation toast, then sent card
        page.goto(base + "/app/?splash=off&sec=feedback")
        page.wait_for_selector("textarea.inp", timeout=8000)
        page.fill("textarea.inp", "ок")
        page.click("button:has-text('Отправить')")
        page.wait_for_selector("#toast:not([hidden])", timeout=5000)
        chk.ok("Напишите чуть подробнее" in page.inner_text("#toast"), "feedback validation toast")
        page.fill("textarea.inp", "Идея: добавить фильтр по монетам в списке сигналов")
        page.click("button:has-text('Отправить')")
        page.wait_for_selector(".fb-ok", timeout=8000)
        chk.ok("отправлено" in page.inner_text(".fb-ok").lower(), "feedback sent card")
        # stats: tables render for the pro user
        page.goto(base + "/app/?splash=off&sec=stats")
        page.wait_for_selector(".sgrid", timeout=8000)
        chk.ok(page.locator(".wbars").count() == 1 and page.locator(".h2", has_text="По стратегиям").count() == 1, "stats blocks")
        shot("07c-stats")
        page.goto(base + "/app/?splash=off&tab=profile")
        page.wait_for_selector(".user-card", timeout=8000)

        # 8. expired access token → one refresh, no login screen
        urllib.request.urlopen(urllib.request.Request(base + "/api/auth/__stub/expire-access", method="POST", data=b"")).read()
        page.goto(base + "/app/?splash=off&tab=signals")
        page.wait_for_selector(".sig-list .sig", timeout=8000)
        chk.ok(page.locator("form.login-form").count() == 0, "refresh kept the session")
        chk.ok(any("/api/auth/refresh" in u for u in api_calls), "refresh endpoint was called")
        new_tok = page.evaluate("localStorage.getItem('chm_access')")
        chk.ok(new_tok and new_tok != tok, "access token rotated")

        # 9. logout → login screen with notice; reload stays on login
        page.click("#tabbar .tab[data-tab=profile]")
        page.wait_for_selector("button:has-text('Выйти')")
        page.click("button:has-text('Выйти')")
        page.wait_for_selector("form.login-form", timeout=5000)
        chk.ok(page.evaluate("localStorage.getItem('chm_access')") is None, "tokens cleared on logout")
        page.reload()
        page.wait_for_selector("form.login-form", timeout=8000)

        # 10. session-only (remember me off) → sessionStorage
        page.fill("input[name=email]", "demo@chm.local")
        page.fill("input[name=password]", "demo1234")
        page.click("form.login-form .sw input")
        page.click("form.login-form button[type=submit]")
        page.wait_for_selector(".sig-list .sig", timeout=8000)   # the URL still deep-links ?tab=signals
        page.click("#tabbar .tab[data-tab=home]")
        page.wait_for_selector(".promo", timeout=8000)
        chk.ok(page.evaluate("sessionStorage.getItem('chm_access')") is not None and page.evaluate("localStorage.getItem('chm_access')") is None, "remember-me off → sessionStorage")
        chk.ok(page.inner_text("#plan-badge") == "FREE", "free badge")
        chk.ok(page.locator(".promo button", has_text="Оформить Pro").count() == 1, "free promo CTA")

        # 11. demo mode: no backend calls, no login
        api_calls.clear()
        page.goto(base + "/app/?demo=pro&splash=off")
        page.wait_for_selector(".promo", timeout=8000)
        chk.ok(page.locator("#demo-badge").is_visible(), "demo badge")
        chk.ok(not api_calls, "demo mode made no API calls")
        shot("10-demo")
        for variant in ["demo=1", "demo=empty", "demo=1&api=off&sec=plan", "demo=pro&genome=off&tab=profile"]:
            page.goto(base + "/app/?splash=off&" + variant)
            page.wait_for_selector("#view .card", timeout=8000)
            page.wait_for_selector("#view .sk", state="detached", timeout=10000)
            chk.ok(page.locator("form.login-form").count() == 0, "demo variant without login: " + variant)
        chk.ok(page.locator("#view .empty", has_text="Раздел недоступен").count() == 0, "genome=off hides the block silently")
        chk.ok(not api_calls, "demo variants made no API calls")

        chk.ok(not errors, "no console/page errors: %s" % errors[:5])
        browser.close()
    except Exception as e:   # dump the page state so a failure is diagnosable from the log
        chk.failures.append("exception: %s" % e)
        try:
            page.screenshot(path=os.path.join(args.shots, "FAIL.png"), full_page=True)
            print("--- page text at failure ---\n" + page.inner_text("body")[:1500], file=sys.stderr)
            print("--- browser errors ---\n" + "\n".join(errors[-10:]), file=sys.stderr)
            print("--- last api calls ---\n" + "\n".join(api_calls[-10:]), file=sys.stderr)
        except Exception:
            pass
        raise
    finally:
        try:
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
