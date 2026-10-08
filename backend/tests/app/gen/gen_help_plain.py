"""gen_help_plain.py — tests/app/fixtures/help_plain.json (me.test.js): the bot's `GET help` payload
(miniapp_api.h_help logic: help_content sections, _strip_html) for ru / en.

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <prod-like venv, python 3.11>/bin/python -I \
        <site>/backend/tests/app/gen/gen_help_plain.py [OUT]      # OUT defaults to tests/app/fixtures/help_plain.json
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
import json, sys
import os
BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
sys.path.insert(0, BOT)
os.chdir(BOT)
import help_content as hc
from miniapp_api import _strip_html

out = {}
for lang in ("ru", "en"):
    sections = []
    for sid, ru_title, en_title in hc.SECTIONS:
        entry = hc.HELP.get(sid) or {}
        raw = entry.get(lang) or entry.get("ru") or ""
        if not raw:
            continue
        sections.append({"id": sid, "number": hc.section_number(sid),
                         "title": en_title if lang == "en" else ru_title,
                         "text": _strip_html(raw)})
    out[lang] = sections
json.dump(out, open(os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, '../fixtures/help_plain.json'), "w", encoding="utf-8"), ensure_ascii=False)
print({k: len(v) for k, v in out.items()})
