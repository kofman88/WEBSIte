"""The bot's /trend command, /trend_on and the «🔕 Не присылать смену тренда» callback
(handlers/trend.py) driven in-process — the texts behind GET /api/app/trend and
POST /api/app/trend/notify on the site (routes/appTrend.js, decision D10).

Run with the production Python (CPython 3.11) from the bot checkout, no bytecode written:

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 PYTHONDONTWRITEBYTECODE=1 \\
        $PY311 -B <site>/backend/tests/app/data/py/drive_trend_cmd.py <site>/backend/tests/app/data/fixtures/trend_cmd.json

handlers/trend.py registers its handlers on an aiogram Dispatcher; here a recording stand-in
collects them (filters ignored) and they are called with stand-in Message / CallbackQuery
objects. trend_monitor's module state (_state, _strength) is seeded per case; set_opted_out
is replaced by a recorder (or a raiser) so no DB is touched.
"""
import asyncio
import json
import os
import sys

sys.path.insert(0, os.getcwd())          # the bot checkout (cwd)

import trend_monitor as tm  # noqa: E402
from handlers import trend as H


class DP:
    def __init__(self):
        self.handlers = {}

    def _deco(self, kind):
        def outer(*_a, **_k):
            def deco(f):
                self.handlers[f.__name__] = f
                return f
            return deco
        return outer

    def __getattr__(self, name):
        if name in ("message", "callback_query"):
            return self._deco(name)
        raise AttributeError(name)


class User:
    def __init__(self, uid):
        self.id = uid


class Msg:
    def __init__(self, uid):
        self.from_user = User(uid)
        self.sent = []

    async def answer(self, text, **kw):
        self.sent.append({"text": text, "parse_mode": kw.get("parse_mode")})


class Cb:
    def __init__(self, uid):
        self.from_user = User(uid)
        self.alerts = []

    async def answer(self, text, show_alert=False, **_kw):
        self.alerts.append({"text": text, "show_alert": show_alert})


class UM:
    def __init__(self, lang, fail=False):
        self.lang, self.fail = lang, fail

    async def get_or_create(self, uid):
        if self.fail:
            raise RuntimeError("db down")
        class U:  # noqa: N801
            pass
        u = U()
        if self.lang != "<absent>":
            u.lang = self.lang
        return u


STATES = [
    ("empty", {}, {}),
    ("15m long only", {"15m": {"trend": "LONG", "since": 1767000000.0, "price": 87000.5}}, {}),
    ("all, strengths", {
        "15m": {"trend": "LONG", "since": 1767000000.0, "price": 1.0},
        "1H": {"trend": "SHORT", "since": 1766990000.0, "price": 1.0},
        "4H": {"trend": "RANGE", "since": 1766900000.0, "price": 1.0},
        "1D": {"trend": "LONG", "since": 1766000000.0, "price": 1.0},
        "1W": {"trend": "SHORT", "since": 1765000000.0, "price": 1.0},
        "1M": {"trend": "LONG", "since": 0.0, "price": 1.0},
    }, {"15m": 83.7, "1H": 0, "4H": 41, "1D": 100, "1W": 12.5}),
    ("15m short, odd words", {
        "15m": {"trend": "SHORT", "since": 1.0, "price": 1.0},
        "4H": {"trend": "WEIRD", "since": 1.0, "price": 1.0},
        "1W": {"trend": "None", "since": 1.0, "price": 1.0},
    }, {"4H": 55}),
    ("15m range", {"15m": {"trend": "RANGE", "since": 1.0, "price": 1.0}, "1H": {"trend": "LONG", "since": 1.0, "price": 1.0}}, {"15m": 7}),
    ("no 15m", {"1H": {"trend": "LONG", "since": 1.0, "price": 1.0}, "1D": {"trend": "SHORT", "since": 1.0, "price": 1.0}}, {"1D": 66.6}),
]


async def main(out_path):
    out = {"trend": [], "off": [], "on": []}
    for name, state, strength in STATES:
        tm._state.clear()
        tm._state.update({k: dict(v) for k, v in state.items()})
        tm._strength.clear()
        tm._strength.update(strength)
        dp = DP()
        H.register_handlers(dp, None, UM("ru"))
        m = Msg(7)
        await dp.handlers["cmd_trend"](m)
        out["trend"].append({"name": name, "state": state, "strength": strength, "get_all": tm.get_all(), "sent": m.sent})

    calls = []

    async def rec(uid, off):
        calls.append([uid, off])

    async def boom(uid, off):
        raise RuntimeError("kv down")

    for lang in ["ru", "en", None, "", "de", "<absent>"]:
        for setter in ("ok", "fail"):
            for um_fail in (False, True):
                tm.set_opted_out = rec if setter == "ok" else boom
                calls.clear()
                dp = DP()
                H.register_handlers(dp, None, UM(lang, fail=um_fail))
                cb = Cb(42)
                await dp.handlers["cb_trend_notify_off"](cb)
                out["off"].append({"lang": lang, "setter": setter, "um_fail": um_fail, "alerts": cb.alerts, "calls": list(calls)})
    for setter in ("ok", "fail"):
        tm.set_opted_out = rec if setter == "ok" else boom
        calls.clear()
        dp = DP()
        H.register_handlers(dp, None, UM("en"))
        m = Msg(42)
        await dp.handlers["cmd_trend_on"](m)
        out["on"].append({"setter": setter, "sent": m.sent, "calls": list(calls)})
    out["meta"] = {"python": sys.version.split()[0], "tfs": list(tm.TFS)}
    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print("trend", len(out["trend"]), "off", len(out["off"]), "on", len(out["on"]))


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1]))
