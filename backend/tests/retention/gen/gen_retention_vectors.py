"""gen_retention_vectors.py — parity vectors for the M17b retention ports
(backend/tests/retention/*.test.js): the bot's engagement.py, drip_campaign.py,
smart_prompts.py and the engagement opt-out button (handlers/subscription.py), run by
the production interpreter (CPython 3.11) on fake bots / user managers / kv.

  A  engagement._which_reminder          random users × boundary expiry offsets
  B  engagement._render / _kb_renew      every type × lang (i18n fallbacks) × user ids
  C  engagement._send_reminder           ok / Forbidden / BadRequest / other × save failure
  D  engagement.engagement_loop          one pass over a mixed user list (sleeps, sends,
                                         saves, log lines), then a failing all_users()
  E  engagement.handle_optout_callback   missing / present / failing user manager
  F  cb_engagement_optout                the real callback handler on a fake dispatcher
  G  drip_campaign                       _process_user over random rows, kv branches,
                                         one drip_loop pass (throttle sleeps, log lines)
  H  smart_prompts                       throttle + GC, free check, both triggers' texts

Run with the bot's venv (the script chdirs into the bot checkout itself):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <venv>/bin/python gen_retention_vectors.py [OUT]
afterwards: rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
from __future__ import annotations

import asyncio
import gzip
import json
import logging
import os
import random
import sys
import time as _time
from types import SimpleNamespace

BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
_CWD = os.getcwd()
os.chdir(BOT)
sys.path.insert(0, BOT)
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")

import faulthandler  # noqa: E402
faulthandler.dump_traceback_later(600, exit=True)

import database  # noqa: E402
import drip_campaign as DC  # noqa: E402
import engagement as E  # noqa: E402
import smart_prompts as SP  # noqa: E402
from aiogram.exceptions import TelegramBadRequest, TelegramForbiddenError  # noqa: E402

OUT = (os.path.join(_CWD, sys.argv[1]) if len(sys.argv) > 1 else
       os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "fixtures", "retention_vectors.json.gz"))
rng = random.Random(0x5E7E1D)
NOW = 1_791_115_200.0 + 0.375            # 2026-10-05 08:00:00.375 UTC
FAKE = [NOW]
_time.time = lambda: FAKE[0]
DAY = 86400.0
out: dict = {"python": sys.version.split()[0], "now": NOW}

LOOP = asyncio.new_event_loop()
asyncio.set_event_loop(LOOP)
run = LOOP.run_until_complete


class _Cap(logging.Handler):
    def __init__(self):
        super().__init__(logging.DEBUG)
        self.lines: list = []

    def emit(self, record):
        self.lines.append([record.levelname.lower(), record.getMessage()])

    def take(self):
        o, self.lines = self.lines, []
        return o


CAP = _Cap()
for _name in ("CHM.Engagement", "CHM.DripCampaign", "CHM.SmartPrompts", "CHM.Handlers.subscription"):
    _lg = logging.getLogger(_name)
    _lg.addHandler(CAP)
    _lg.setLevel(logging.DEBUG)
    _lg.propagate = False

FLAGS = ["reminder_3d_sent", "reminder_1d_sent", "reminder_7d_after_sent",
         "reminder_14d_after_sent", "reminder_30d_after_sent"]
FIELDS = ["user_id", "lang", "active", "reminders_optout", "last_reminder_at", "sub_status",
          "sub_plan", "sub_expires"] + FLAGS


def udict(u):
    return {k: getattr(u, k) for k in FIELDS if hasattr(u, k)}


# ═══════════════════════════════════════════════════════════════════════
# A. _which_reminder
# ═══════════════════════════════════════════════════════════════════════
OFFSETS_D = [-400, -40, -30.5, -30, -30 + 1e-9, -29.999, -20, -14, -14 + 1e-9, -13.99, -10, -7, -7 + 1e-9,
             -6.99, -3, -1, -0.5, -1e-9, 0, 1e-9, 0.25, 1 - 1e-9, 1, 1 + 1e-9, 1.5, 2.999, 3, 3 + 1e-9, 3.5, 4,
             10, 365]
STATUSES = ["trial", "active", "expired", "banned", "", "Active", "EXPIRED"]


def rand_user(uid):
    exp_kind = rng.random()
    if exp_kind < 0.08:
        sub_expires = 0.0
    else:
        sub_expires = NOW + rng.choice(OFFSETS_D) * DAY + (rng.choice([0, 0, 0, rng.uniform(-3600, 3600)]))
    last_kind = rng.random()
    if last_kind < 0.55:
        last = 0.0
    elif last_kind < 0.65:
        last = NOW - 24 * 3600
    elif last_kind < 0.7:
        last = NOW - 24 * 3600 + 1e-6
    elif last_kind < 0.75:
        last = NOW + 120.0
    else:
        last = NOW - rng.uniform(0, 3 * DAY)
    u = SimpleNamespace(
        user_id=uid, lang=rng.choice(["ru", "en", "", None, "de"]), active=rng.random() < 0.85,
        reminders_optout=rng.random() < 0.1, last_reminder_at=last,
        sub_status=rng.choice(STATUSES), sub_plan=rng.choice(["free", "pro", "free", ""]),
        sub_expires=sub_expires,
    )
    for f in FLAGS:
        setattr(u, f, rng.random() < 0.3)
    return u


which = []
for i in range(2500):
    u = rand_user(9000 + i)
    which.append({"user": udict(u), "now": NOW, "result": E._which_reminder(u, NOW)})
# exact boundaries on a clean user
for status in ("trial", "active", "expired"):
    for off in OFFSETS_D:
        u = SimpleNamespace(user_id=1, lang="ru", active=True, reminders_optout=False, last_reminder_at=0.0,
                            sub_status=status, sub_plan="pro", sub_expires=NOW + off * DAY)
        for f in FLAGS:
            setattr(u, f, False)
        which.append({"user": udict(u), "now": NOW, "result": E._which_reminder(u, NOW)})
out["which"] = which
print("A which", len(which), file=sys.stderr)

# ═══════════════════════════════════════════════════════════════════════
# B. texts + keyboard
# ═══════════════════════════════════════════════════════════════════════


def kb_rows(kb):
    return [[{"text": b.text, "url": b.url, "callback_data": b.callback_data} for b in row] for row in kb.inline_keyboard]


texts = []
for rt in E._REMINDER_KEYS:
    for lang in ("ru", "en", "", None, "de", "EN"):
        for uid in (1, 123456789, 10 ** 12 + 7):
            u = SimpleNamespace(user_id=uid, lang=lang)
            texts.append({"type": rt, "lang": lang, "user_id": uid, "text": E._render(rt, u),
                          "flag": E._flag_for(rt)})
kbs = []
for lang in ("ru", "en", "", None, "de"):
    for uid in (1, 987654321):
        kbs.append({"lang": lang, "user_id": uid, "rows": kb_rows(E._kb_renew(uid, with_optout=True, lang=E._user_lang(SimpleNamespace(lang=lang))))})
out["texts"] = texts
out["keyboards"] = kbs

# ═══════════════════════════════════════════════════════════════════════
# C. _send_reminder
# ═══════════════════════════════════════════════════════════════════════
BAD_MSG = "Bad Request: notification not stored"


class FakeBot:
    def __init__(self, plan):
        self.plan = plan          # uid → 'ok' | 'forbidden' | 'bad' | 'other'
        self.calls: list = []

    async def send_message(self, uid, text, **kw):
        rec = {"uid": uid, "text": text}
        for k, v in kw.items():
            rec[k] = kb_rows(v) if k == "reply_markup" else v
        self.calls.append(rec)
        what = self.plan.get(uid, "ok")
        if what == "forbidden":
            raise TelegramForbiddenError(method=None, message="Forbidden: user is deactivated")
        if what == "bad":
            raise TelegramBadRequest(method=None, message=BAD_MSG)
        if what == "other":
            raise RuntimeError("dispatch exploded")
        return SimpleNamespace(message_id=1)


class FakeUM:
    def __init__(self, users=None, save_fail=(), get_fail=()):
        self.users = {u.user_id: u for u in (users or [])}
        self.save_fail = set(save_fail)
        self.get_fail = set(get_fail)
        self.saved: list = []

    async def save(self, user):
        if user.user_id in self.save_fail:
            raise RuntimeError("database is locked")
        self.saved.append(udict(user))

    async def get(self, uid):
        if uid in self.get_fail:
            raise RuntimeError("lookup failed")
        return self.users.get(uid)

    async def get_or_create(self, uid, username=""):
        return await self.get(uid)

    async def all_users(self):
        if "all" in self.get_fail:
            raise RuntimeError("db locked")
        return list(self.users.values())


def base_user(uid, **kw):
    u = SimpleNamespace(user_id=uid, lang="ru", active=True, reminders_optout=False, last_reminder_at=0.0,
                        sub_status="active", sub_plan="pro", sub_expires=NOW + 2 * DAY)
    for f in FLAGS:
        setattr(u, f, False)
    for k, v in kw.items():
        setattr(u, k, v)
    return u


sends = []
for outcome in ("ok", "forbidden", "bad", "other"):
    for save_fail in (False, True):
        for rt in ("3d", "1d", "7d_after", "14d_after", "30d_after"):
            for lang in ("ru", "en"):
                FAKE[0] = NOW + rng.uniform(0, 5)
                u = base_user(4100 + len(sends), lang=lang)
                bot = FakeBot({u.user_id: outcome})
                um = FakeUM([u], save_fail=[u.user_id] if save_fail else [])
                CAP.take()
                ok = run(E._send_reminder(bot, u, rt, um))
                sends.append({"outcome": outcome, "save_fail": save_fail, "type": rt, "lang": lang, "now": FAKE[0],
                              "user_before": udict(base_user(u.user_id, lang=lang)), "result": ok,
                              "user_after": udict(u), "calls": bot.calls, "saved": um.saved, "logs": CAP.take()})
FAKE[0] = NOW
out["sends"] = sends
print("C sends", len(sends), file=sys.stderr)

# ═══════════════════════════════════════════════════════════════════════
# D. engagement_loop
# ═══════════════════════════════════════════════════════════════════════
_real_sleep = asyncio.sleep


class _Stop(Exception):
    pass


def loop_users():
    return [
        base_user(5001, sub_expires=NOW + 2 * DAY),                                # 3d
        base_user(5002, sub_expires=NOW + 0.5 * DAY, lang="en"),                   # 1d
        base_user(5003, active=False, sub_expires=NOW + 0.5 * DAY),                # inactive
        base_user(5004, sub_status="expired", sub_expires=NOW - 8 * DAY),          # 7d_after
        base_user(5005, sub_status="expired", sub_expires=NOW - 15 * DAY),         # 14d_after → forbidden
        base_user(5006, sub_status="expired", sub_expires=NOW - 31 * DAY),         # 30d_after → bad
        base_user(5007, reminders_optout=True, sub_expires=NOW + 0.5 * DAY),       # opted out
        base_user(5008, last_reminder_at=NOW - 3600, sub_expires=NOW + 0.5 * DAY),  # anti-spam
        base_user(5009, sub_expires=NOW + 0.5 * DAY),                              # other error
        base_user(5010, sub_expires=NOW + 2 * DAY, reminder_3d_sent=True),         # nothing
        base_user(5011, sub_expires=NOW + 2.5 * DAY),                              # 3d, save fails
        base_user(5012, sub_status="trial", sub_expires=NOW + 0.2 * DAY),          # 1d
    ]


def run_loop(users, plan, save_fail=(), get_fail=()):
    sleeps: list = []

    async def fake_sleep(s):
        sleeps.append(s)
        FAKE[0] += s
        if s == E.LOOP_INTERVAL_S:
            raise _Stop()

    E.asyncio.sleep = fake_sleep
    bot = FakeBot(plan)
    um = FakeUM(users, save_fail=save_fail, get_fail=get_fail)
    CAP.take()
    FAKE[0] = NOW
    try:
        run(E.engagement_loop(bot, um))
    except _Stop:
        pass
    finally:
        E.asyncio.sleep = _real_sleep
    return {"sleeps": sleeps, "calls": bot.calls, "saved": um.saved, "logs": CAP.take(),
            "users_after": [udict(u) for u in users]}


us = loop_users()
loops = [dict(run_loop(us, {5005: "forbidden", 5006: "bad", 5009: "other"}, save_fail=[5011]),
              users=[udict(u) for u in loop_users()], plan={"5005": "forbidden", "5006": "bad", "5009": "other"},
              save_fail=[5011], get_fail=[])]
loops.append(dict(run_loop(loop_users(), {}, get_fail=["all"]), users=[udict(u) for u in loop_users()], plan={},
                  save_fail=[], get_fail=["all"]))
FAKE[0] = NOW
out["loops"] = loops
out["loop_constants"] = {"LOOP_INTERVAL_S": E.LOOP_INTERVAL_S, "MIN_GAP": E.MIN_GAP_BETWEEN_REMINDERS,
                         "THROTTLE": E.SEND_THROTTLE_S}

# ═══════════════════════════════════════════════════════════════════════
# E. handle_optout_callback
# ═══════════════════════════════════════════════════════════════════════
optouts = []
for case in ("missing", "present", "get_fails", "save_fails"):
    u = base_user(6001)
    um = FakeUM([] if case == "missing" else [u], save_fail=[6001] if case == "save_fails" else [],
                get_fail=[6001] if case == "get_fails" else [])
    CAP.take()
    ok = run(E.handle_optout_callback(6001, um))
    optouts.append({"case": case, "result": ok, "user_after": udict(u), "saved": um.saved, "logs": CAP.take()})
out["optout"] = optouts

# ═══════════════════════════════════════════════════════════════════════
# F. cb_engagement_optout (the real handler)
# ═══════════════════════════════════════════════════════════════════════
import handlers.subscription as HS  # noqa: E402

HANDLERS: dict = {}


class _Reg:
    def __call__(self, *a, **kw):
        def deco(fn):
            HANDLERS.setdefault(fn.__name__, fn)
            return fn
        return deco


class FakeDP:
    def __getattr__(self, name):
        return _Reg()


SUB_UM = FakeUM()
HS.register_handlers(FakeDP(), SimpleNamespace(), SUB_UM, SimpleNamespace(), SimpleNamespace())
cb_opt = HANDLERS["cb_engagement_optout"]


class FakeCB:
    def __init__(self, data, from_id):
        self.data = data
        self.from_user = SimpleNamespace(id=from_id) if from_id is not None else None
        self.answers: list = []

    async def answer(self, text=None, show_alert=False, **kw):
        self.answers.append({"text": text, "show_alert": show_alert})


DATAS = ["engagement_optout:7001", "engagement_optout:7002", "engagement_optout: 7001 ", "engagement_optout:+7001",
         "engagement_optout:7_001", "engagement_optout:٧٠٠١", "engagement_optout:", "engagement_optout:abc",
         "engagement_optout:7001:9", "engagement_optout:7001.0", "engagement_optout:0007001",
         "engagement_optout:" + "9" * 40, "engagement_optout:-7001", "engagement_optout:7003"]
cb_cases = []
for data in DATAS:
    for caller, lang, exists in ((7001, "ru", True), (7001, "en", True), (7001, None, False), (7002, "en", True)):
        SUB_UM.users = {}
        SUB_UM.saved = []
        SUB_UM.get_fail = set()
        if exists:
            SUB_UM.users[caller] = base_user(caller, lang=lang)
        if caller != 7001:
            SUB_UM.users[7001] = base_user(7001, lang="ru")
        cb = FakeCB(data, caller)
        CAP.take()
        run(cb_opt(cb))
        cb_cases.append({"data": data, "caller": caller, "lang": lang, "exists": exists,
                         "users": sorted(SUB_UM.users.keys()), "answers": cb.answers, "saved": SUB_UM.saved,
                         "logs": CAP.take()})
# the caller's own lookup failing → lang 'ru'; the opt-out lookup failing → failed text
SUB_UM.users = {7001: base_user(7001, lang="en")}
SUB_UM.saved = []
SUB_UM.get_fail = {7001}
cb = FakeCB("engagement_optout:7001", 7001)
CAP.take()
run(cb_opt(cb))
cb_cases.append({"data": "engagement_optout:7001", "caller": 7001, "lang": "en", "exists": True, "users": [7001],
                 "get_fail": True, "answers": cb.answers, "saved": SUB_UM.saved, "logs": CAP.take()})
out["optout_cb"] = cb_cases
print("F cb", len(cb_cases), file=sys.stderr)

# ═══════════════════════════════════════════════════════════════════════
# G. drip_campaign
# ═══════════════════════════════════════════════════════════════════════
KV: dict = {}
KV_FAIL = {"get": False, "set": False}


async def kv_get(k):
    if KV_FAIL["get"]:
        raise RuntimeError("kv read failed")
    return KV.get(k)


async def kv_set(k, v):
    if KV_FAIL["set"]:
        raise RuntimeError("kv write failed")
    KV[k] = v


database.db_kv_get = kv_get
database.db_kv_set = kv_set

drip_msgs = []
for day in range(0, 10):
    for lang in ("ru", "en"):
        text, btns = DC._build_message(day, lang)
        drip_msgs.append({"day": day, "lang": lang, "text": text, "buttons": [list(b) for b in btns]})
out["drip_messages"] = drip_msgs

AGES = [-2.0, -1.0, -0.999, -0.5, -1e-9, 0.0, 1e-9, 0.04, 0.5, 0.95, 0.999999, 1.0, 1.5, 2.0, 2.0001, 2.5, 2.99, 3.0,
        3.7, 4.0, 4.4, 5.0, 6.0, 6.5, 7.0, 7.9999, 8.0, 8.0000001, 9.0, 30.0]
PLANS = [None, "", "free", "FREE", "Free", "free ", "pro", "PRO", "elite", "beginner", "trial"]
drip_cases = []
for i in range(700):
    uid = rng.choice([0, -5, 8000 + i, 8000 + i, 8000 + i])
    ck = rng.random()
    if ck < 0.06:
        created = None
    elif ck < 0.1:
        created = 0.0
    elif ck < 0.12:
        created = -100.0
    else:
        created = NOW - rng.choice(AGES) * DAY + rng.choice([0.0, 0.0, rng.uniform(-30, 30)])
    row = {"user_id": uid, "sub_plan": rng.choice(PLANS), "created_at": created}
    KV.clear()
    pre = {}
    if uid > 0 and rng.random() < 0.2:
        day_guess = int((NOW - (created or 0)) / DAY) + 1
        pre[DC._kv_key(uid, day_guess)] = rng.choice(["1791115200", "", "0"])
    KV.update(pre)
    KV_FAIL["get"] = rng.random() < 0.05
    KV_FAIL["set"] = rng.random() < 0.05
    outcome = rng.choice(["ok"] * 8 + ["bad", "other"])
    bot = FakeBot({uid: outcome})
    CAP.take()
    FAKE[0] = NOW
    err = None
    try:
        run(DC._process_user(bot, row))
    except Exception as e:  # noqa: BLE001
        err = {"etype": type(e).__name__, "msg": str(e)}
    drip_cases.append({"row": row, "kv_before": pre, "kv_fail": dict(KV_FAIL), "outcome": outcome,
                       "calls": bot.calls, "kv_after": dict(KV), "logs": CAP.take(), "error": err})
KV_FAIL["get"] = KV_FAIL["set"] = False
out["drip"] = drip_cases
print("G drip", len(drip_cases), file=sys.stderr)


def drip_loop_run(rows, plan, fail_rows=False):
    sleeps: list = []
    n_3600 = [0]

    async def fake_sleep(s):
        sleeps.append(s)
        FAKE[0] += s
        if s == DC._LOOP_INTERVAL_S:
            n_3600[0] += 1
            if n_3600[0] >= 2:
                raise asyncio.CancelledError()

    async def all_rows():
        if fail_rows:
            raise RuntimeError("no such table: users")
        return [dict(r) for r in rows]

    DC.asyncio.sleep = fake_sleep
    database.db_get_all_users = all_rows
    KV.clear()
    bot = FakeBot(plan)
    CAP.take()
    FAKE[0] = NOW
    try:
        run(DC.drip_loop(bot, None))
    except asyncio.CancelledError:
        pass
    finally:
        DC.asyncio.sleep = _real_sleep
    return {"sleeps": sleeps, "calls": bot.calls, "kv_after": dict(KV), "logs": CAP.take()}


loop_rows = []
for i in range(60):
    age = rng.choice([0.2, 2.5, 4.5, 6.5, 1.5, 9.0])
    loop_rows.append({"user_id": 8500 + i, "sub_plan": rng.choice(["free", "free", "pro", None]),
                      "created_at": NOW + DC._LOOP_INTERVAL_S - age * DAY})
out["drip_loops"] = [
    dict(drip_loop_run(loop_rows, {8503: "bad"}), rows=loop_rows, plan={"8503": "bad"}, fail_rows=False),
    dict(drip_loop_run(loop_rows, {}, fail_rows=True), rows=loop_rows, plan={}, fail_rows=True),
]
FAKE[0] = NOW
out["drip_constants"] = {"DAYS": list(DC._DRIP_DAYS), "LOOP_INTERVAL_S": DC._LOOP_INTERVAL_S,
                         "MAX_AGE_DAYS": DC._MAX_AGE_DAYS}

# ═══════════════════════════════════════════════════════════════════════
# H. smart_prompts
# ═══════════════════════════════════════════════════════════════════════
ROWS = [{"user_id": 1, "sub_plan": "free"}, {"user_id": 2, "sub_plan": "pro"}, {"user_id": 3, "sub_plan": None},
        {"user_id": 4, "sub_plan": "FREE"}, {"user_id": 5, "sub_plan": ""}, {"user_id": 6, "sub_plan": "elite"}]
ROWS_FAIL = [False]


async def all_users_sp():
    if ROWS_FAIL[0]:
        raise RuntimeError("db locked")
    return [dict(r) for r in ROWS]


database.db_get_all_users = all_users_sp

free_checks = []
for uid in (1, 2, 3, 4, 5, 6, 7):
    free_checks.append({"uid": uid, "result": run(SP._is_free_active(uid))})
ROWS_FAIL[0] = True
free_checks.append({"uid": 1, "rows_fail": True, "result": run(SP._is_free_active(1))})
ROWS_FAIL[0] = False
out["sp_free"] = {"rows": ROWS, "cases": free_checks}

SYMS = ["BTC-USDT-SWAP", "eth-usdt-swap", "PEPE-USDT", "SOL", "-USDT-SWAP", "", "1000PEPE-USDT-SWAP", "ß-USDT"]
RS = [0.25, 0.35, 0.05, 0.15, 1.05, 2.45, 1.0, 3.333, 0.04, 12.95, 7.25, 1e-9, 99.95]
wins = []
SP._PROMPT_LAST.clear()
step = 0
for sym in SYMS:
    for r in RS:
        for uid in (1, 2, 7):
            step += 1
            FAKE[0] = NOW + step * 5000.0
            outcome = "other" if step % 11 == 0 else "ok"
            bot = FakeBot({uid: outcome})
            CAP.take()
            run(SP.trigger_after_win(bot, uid, sym, r))
            wins.append({"uid": uid, "symbol": sym, "r": r, "now": FAKE[0], "outcome": outcome, "calls": bot.calls,
                         "logs": CAP.take(), "last": SP._PROMPT_LAST.get((uid, "after_win"))})
out["sp_win"] = wins
quotas = []
SP._PROMPT_LAST.clear()
for step in range(40):
    uid = rng.choice([1, 2, 4, 5, 7])
    FAKE[0] = NOW + step * rng.choice([3600.0, 43200.0, 86400.0, 86399.0])
    outcome = rng.choice(["ok", "ok", "ok", "bad"])
    bot = FakeBot({uid: outcome})
    CAP.take()
    run(SP.trigger_after_quota_hit(bot, uid))
    quotas.append({"uid": uid, "now": FAKE[0], "outcome": outcome, "calls": bot.calls, "logs": CAP.take(),
                   "last": SP._PROMPT_LAST.get((uid, "after_quota_hit"))})
out["sp_quota"] = quotas

# throttle + GC on the module's dict
gc_steps = []
SP._PROMPT_LAST.clear()
t = NOW
for i in range(1300):
    t += rng.choice([1.0, 30.0, 400.0])
    FAKE[0] = t
    uid = rng.randint(1, 1500)
    kind = rng.choice(["after_win", "after_quota_hit"])
    can = SP._can_send(uid, kind)
    if can:
        SP._mark_sent(uid, kind)
    gc_steps.append([t, uid, kind, can, len(SP._PROMPT_LAST)])
out["sp_gc"] = {"steps": gc_steps, "final": sorted([[k[0], k[1], v] for k, v in SP._PROMPT_LAST.items()]),
                "TTL": SP._PROMPT_TTL_S, "GC_THRESHOLD": SP._GC_THRESHOLD}
FAKE[0] = NOW

with open(OUT, "wb") as f:
    f.write(gzip.compress(json.dumps(out, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9, mtime=0))
print("wrote", OUT, file=sys.stderr)
