"""Real network failures through the bot's own HTTP stacks → fixtures/net_errors.json.

  cd /home/user/MAIN_BOT/CHM_BREAKER_V4 && env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 $VENV/bin/python /path/to/backend/tests/exchanges/py/gen_net_errors.py; \
    rm -f signal_registry.json

The replay suites inject transport failures as scripted exceptions; this generator records what
the real client libraries raise for real failures, so the production JS transport
(transport.fetchTransport + bybitHttp.requestsError) can be held to the same class and text.
Everything is local (no outbound traffic):

  dns        RFC 2606 `.invalid` host → getaddrinfo fails
  refused    closed 127.0.0.1 port
  close      server accepts, reads the request, closes without answering
  reset      server answers the request with a TCP RST (SO_LINGER 0)
  truncated  Content-Length: 100, 8 body bytes, close
  chunked    chunked body cut after the first chunk
  silent     server never answers (read timeout)
  html       502 text/html page (trader level only)

`client` rows: one aiohttp 3.14 request (BingX / Binance / OKX / Bybit async helpers) and one
requests 2.x request (pybit) per mode → {type, str}. `trader` rows: the bot's own
bingx/binance/okx `_request` and a pybit session call with the base URL pointed at the failing
endpoint → the returned dict / raised exception.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import struct
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
BOT = "/home/user/MAIN_BOT/CHM_BREAKER_V4"
sys.path.insert(0, BOT)
os.chdir(BOT)

import aiohttp  # noqa: E402
import requests  # noqa: E402

DNS_HOST = "exchange-host-that-does-not-exist.invalid"
TRUNC_BODY = b'{"code":'


def _serve(mode):
    s = socket.socket()
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(("127.0.0.1", 0))
    s.listen(64)
    port = s.getsockname()[1]

    def handle(c):
        try:
            c.recv(65536)
            if mode == "close":
                c.close()
            elif mode == "reset":
                c.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                c.close()
            elif mode == "truncated":
                c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n" + TRUNC_BODY)
                time.sleep(0.05)
                c.close()
            elif mode == "chunked":
                c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n8\r\n" + TRUNC_BODY + b"\r\n")
                time.sleep(0.05)
                c.close()
            elif mode == "html":
                body = b"<html>502 Bad Gateway</html>"
                c.sendall(b"HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/html\r\nContent-Length: %d\r\nConnection: close\r\n\r\n" % len(body) + body)
                c.close()
            elif mode == "silent":
                time.sleep(4)
                c.close()
        except OSError:
            pass

    def run():
        while True:
            try:
                c, _ = s.accept()
            except OSError:
                return
            threading.Thread(target=handle, args=(c,), daemon=True).start()
    threading.Thread(target=run, daemon=True).start()
    return port


def _closed_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _exc(e):
    return {"type": type(e).__name__, "str": str(e)}


async def _aio(url, timeout):
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as s:
            async with s.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as r:
                return {"status": r.status, "text": await r.text()}
    except BaseException as e:  # noqa: BLE001
        return _exc(e)


def _req(url, timeout):
    try:
        r = requests.Session().request("GET", url, timeout=timeout)
        return {"status": r.status_code, "text": r.text}
    except Exception as e:  # noqa: BLE001
        return _exc(e)


def bases():
    ports = {m: _serve(m) for m in ("close", "reset", "truncated", "chunked", "silent", "html")}
    refused = _closed_port()
    b = {"dns": f"https://{DNS_HOST}", "refused": f"https://127.0.0.1:{refused}"}
    for m, p in ports.items():
        b[m] = f"http://127.0.0.1:{p}"
    return b


async def trader_rows(b):
    import bingx_trader as bx
    import binance_trader as bn
    import okx_trader as ok
    import bybit_trader as by
    rows = []
    for mode in ("dns", "refused", "close", "reset", "truncated", "chunked", "html"):
        base = b[mode]
        for name, mod in (("bingx", bx), ("binance", bn), ("okx", ok)):
            mod._http_session = None
            mod.BASE_URL = base
            if name == "bingx":
                bx._rate_penalty_until = 0.0
                path, call = "/openApi/swap/v2/user/balance", bx._request("GET", "/openApi/swap/v2/user/balance", "k", "s")
            elif name == "binance":
                path, call = "/fapi/v2/balance", bn._request("GET", "/fapi/v2/balance", "k", "s")
            else:
                path, call = "/api/v5/account/balance", ok._request("GET", "/api/v5/account/balance", "k", "s", "pp")
            try:
                got = {"result": await call}
            except Exception as e:  # noqa: BLE001
                got = {"raised": _exc(e)}
            rows.append({"exchange": name, "mode": mode, "base": base, "path": path, "got": got})
            s = mod._http_session
            if s is not None and not s.closed:
                await s.close()
            mod._http_session = None
        if mode != "html":  # pybit's FailedRequestError text carries the wall-clock ErrTime
            sess = by._get_session("BYKEY123", "bysecret")
            sess.endpoint = base
            try:
                got = {"result": sess.get_wallet_balance(accountType="UNIFIED", coin="USDT")}
            except Exception as e:  # noqa: BLE001
                got = {"raised": _exc(e)}
            rows.append({"exchange": "bybit", "mode": mode, "base": base, "path": "/v5/account/wallet-balance", "got": got})
            by._pybit_sessions.clear()
    return rows


def main():
    b = bases()
    client = []
    for mode in ("dns", "refused", "close", "reset", "truncated", "chunked", "silent"):
        url = b[mode] + ("/v5/market/time?category=linear&symbol=BTCUSDT" if mode in ("dns", "refused") else "/v5/market/time")
        client.append({"mode": mode, "url": url, "client": "aiohttp", "timeout": 1, "got": asyncio.run(_aio(url, 1))})
        client.append({"mode": mode, "url": url, "client": "requests", "timeout": 1, "got": _req(url, 1)})
    trader = asyncio.run(trader_rows(b))
    out = {"bases": b, "client": client, "trader": trader}
    path = os.path.join(HERE, "..", "fixtures", "net_errors.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    for r in client:
        print(r["mode"].ljust(10), r["client"].ljust(9), json.dumps(r["got"], ensure_ascii=False)[:200])
    for r in trader:
        print(r["exchange"].ljust(8), r["mode"].ljust(10), json.dumps(r["got"], ensure_ascii=False)[:200])
    print("wrote", path)


if __name__ == "__main__":
    main()
