"""gen_bot_body.py — vectors for services/engine/botBody.js from the bot's own
miniapp_api._read_body() running on a real aiohttp server (Python 3.11 like prod).

Run from the bot directory with the bot's venv:
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python <this file> > bot_body.json
Each case: raw body bytes (hex) + Content-Type header → the dict _read_body returned,
encoded with NaN/Infinity markers so JSON can carry them.
"""
import asyncio, json, math, os, sys
sys.path.insert(0, os.getcwd())   # the bot directory
from aiohttp import web
from aiohttp.test_utils import TestServer, TestClient
import miniapp_api

U = lambda s: s.encode("utf-8")
CASES = [
    (b"", None), (b"", "application/json"), (b"{}", None), (U('{"lang":"en"}'), "application/json"),
    (U('{"lang":"en"}'), "text/plain"), (U('{"lang":"en"}'), "application/x-www-form-urlencoded"),
    (U('{"lang":"en"}'), "application/octet-stream"), (U('{"lang":"en"}'), None),
    (b"\xef\xbb\xbf" + U('{"lang":"en"}'), "application/json"),
    (b"\xef\xbb\xbf" + U('{"lang":"en"}'), "application/json; charset=utf-8-sig"),
    (U('{"lang":"é"}'), "application/json; charset=utf-8"),
    (U('{"lang":"é"}'), "application/json; charset=latin-1"),
    (U('{"lang":"é"}'), "application/json; charset=\"UTF-8\""),
    (U('{"lang":"é"}'), "application/json; charset=ascii"),
    (U('{"lang":"en"}'), "application/json; charset=us-ascii"),
    (U('{"lang":"en"}'), "application/json; charset=bogus-xyz"),
    (U('{"lang":"en"}'), "application/json; charset=utf8"),
    (U('{"lang":"en"}'), "application/json; charset=UTF_8"),
    (U('{"lang":"en"}'), "application/json;charset=l1"),
    (b'{"lang":"\xff"}', "application/json"), (b'{"lang":"\xed\xa0\x80"}', "application/json"),
    (b'{"lang":"\x80"}', "application/json; charset=latin-1"),
    (U("not json"), "application/json"), (U("{"), "application/json"), (U('"LEVELS"'), "application/json"),
    (U("[1]"), "application/json"), (U('[{"strategy":"LEVELS"}]'), None), (U("42"), None), (U("null"), None),
    (U("true"), None), (U(" \t\n{\"a\":1}\r\n "), None), (U('{"a":1}x'), None), (U('{"a":1} {"b":2}'), None),
    (U('{"a": NaN, "b": Infinity, "c": -Infinity}'), None), (U('{"a": [NaN, 1e400, -1e400]}'), None),
    (U("{NaN: 1}"), None), (U('{"a": -NaN}'), None), (U('{"a": 1NaN}'), None), (U('{"a": nan}'), None),
    (U('{"a": "NaN", "b": "x\\"NaN"}'), None), (U('{"a": 1, "a": 2}'), None), (U('{"a": 1.0, "b": 1e-05}'), None),
    (U('{"a": "\\u00e9\\ud83d\\ude00"}'), None), (U('{"a": "tab\there"}'), None), (U("{'a': 1}"), None),
    (U('{"a": 01}'), None), (U('{"a": .5}'), None), (U('{"a": +1}'), None), (U('{"a": 1.}'), None),
    (U('{"a": true, "b": null, "c": {"d": [1, "x", false]}}'), None), (U("NaN"), None), (U("Infinity"), None),
    (U('{"strategy":"levels","long":true,"short":false}'), "application/json"),
]

def enc(v):
    if isinstance(v, float):
        if math.isnan(v): return {"$f": "nan"}
        if math.isinf(v): return {"$f": "inf" if v > 0 else "-inf"}
        return {"$f": repr(v)}
    if isinstance(v, bool) or v is None or isinstance(v, (int, str)): return v
    if isinstance(v, list): return [enc(x) for x in v]
    if isinstance(v, dict): return {"$o": [[k, enc(x)] for k, x in v.items()]}
    raise TypeError(type(v))

async def main():
    out = []
    async def h(request):
        return web.json_response({"r": enc(await miniapp_api._read_body(request))})
    app = web.Application()
    app.router.add_post("/b", h)
    async with TestClient(TestServer(app)) as c:
        for body, ctype in CASES:
            headers = {} if ctype is None else {"Content-Type": ctype}
            if ctype is None:
                headers["Content-Type"] = ""          # aiohttp client would add application/octet-stream
            r = await c.post("/b", data=body, headers=headers)
            out.append({"hex": body.hex(), "ctype": ctype, "result": (await r.json())["r"]})
    json.dump({"python": sys.version.split()[0], "cases": out}, sys.stdout, ensure_ascii=True, indent=1)

asyncio.run(main())
