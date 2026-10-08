"""Real-wire capture for the adversarial generator (gen_adversarial.py).

harness.py records what the bot's traders hand to their HTTP layer. This module additionally
sends every one of those requests through the REAL client library the bot uses — aiohttp
3.14 (BingX / Binance / OKX / Bybit async helpers) and requests 2.x (pybit) — to a local
plain-HTTP echo server, and records the bytes that arrive: method, request-target (path +
query exactly as written on the wire), header fields and body.

Only the origin is redirected (`https://host` → `http://127.0.0.1:<port>`); path and query
go through the library untouched, so aiohttp/yarl requoting, `params=` handling, and the
`yarl.URL(encoded=True)` pass-through of BingX are the real ones. The trader still consumes
the scripted responses of harness.Router — the echo reply is only read back by this module.

Header names are lower-cased. Transport-level headers that the client library adds on its
own and that no trader sets (host, user-agent, accept-encoding, connection, content-length)
are left out; everything else — including the library's default `accept` and implicit
`content-type` — is kept, so the JS side (Node fetch) is compared field by field.
"""
from __future__ import annotations

import asyncio
import http.server
import json
import re
import socketserver
import threading

import aiohttp
import requests
import yarl

import harness

TRANSPORT_HEADERS = {"host", "user-agent", "accept-encoding", "connection", "content-length"}
_ORIGIN_RE = re.compile(r"^https?://[^/?#]+")

_server = None
_port = 0


class _Echo(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _handle(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n).decode("utf-8") if n else None
        hdrs = {}
        for k, v in self.headers.items():
            kl = k.lower()
            if kl in TRANSPORT_HEADERS:
                continue
            hdrs[kl] = v
        rec = {"method": self.command, "target": self.path, "headers": hdrs, "body": body}
        out = json.dumps(rec).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(out)

    do_GET = do_POST = do_DELETE = do_PUT = _handle

    def log_message(self, *a):  # silence
        pass


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def start():
    global _server, _port
    if _server is None:
        _server = _Server(("127.0.0.1", 0), _Echo)
        _port = _server.server_address[1]
        threading.Thread(target=_server.serve_forever, daemon=True).start()
    return _port


def _local(url):
    if isinstance(url, yarl.URL):
        # encoded=True URLs (BingX) keep their raw path/query; swap the origin only
        raw = str(url)
        return yarl.URL(_ORIGIN_RE.sub(f"http://127.0.0.1:{_port}", raw), encoded=True)
    return _ORIGIN_RE.sub(f"http://127.0.0.1:{_port}", str(url))


def _aio_send(method, url, headers, params, data):
    """Send one request with a fresh real aiohttp session on a private loop/thread."""
    box = {}

    async def go():
        async with aiohttp.ClientSession() as s:
            async with s.request(method, _local(url), headers=headers, params=params, data=data) as r:
                box["echo"] = json.loads(await r.text())

    def run():
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(go())
        except Exception as e:  # noqa: BLE001
            box["error"] = repr(e)
        finally:
            loop.close()
    t = threading.Thread(target=run)
    t.start()
    t.join(20)
    return box.get("echo") or {"error": box.get("error", "no echo")}


_REAL_SEND = requests.Session.send
_ADAPTER = requests.adapters.HTTPAdapter()


def _requests_send(prepared):
    p = prepared.copy()
    p.url = _ORIGIN_RE.sub(f"http://127.0.0.1:{_port}", p.url)
    try:
        r = _ADAPTER.send(p, timeout=10)
        return json.loads(r.content.decode())
    except Exception as e:  # noqa: BLE001
        return {"error": repr(e)}


def _passed_headers(headers, drop_requests_defaults):
    out = {}
    for k, v in (headers or {}).items():
        kl = k.lower()
        if drop_requests_defaults and kl in TRANSPORT_HEADERS:
            continue
        out[kl] = v
    return out


def install():
    """Patch harness so every recorded request also carries `hdrs` (all headers the trader
    passed, lower-cased) and `wire` (what the real client library put on the wire)."""
    start()
    orig_do = harness.FakeAioSession._do

    def _do(self, method, url, headers=None, params=None, data=None, **k):
        n = len(self.router.log)
        echo = _aio_send(method, url, headers, params, data)
        try:
            return orig_do(self, method, url, headers=headers, params=params, data=data, **k)
        finally:
            if len(self.router.log) > n:
                self.router.log[n]["hdrs"] = _passed_headers(headers, False)
                self.router.log[n]["wire"] = echo
    harness.FakeAioSession._do = _do

    orig_install = harness.install_requests_fake

    def install_requests_fake(router):
        orig_install(router)
        fake_send = requests.Session.send

        def _send(self, request, **kwargs):
            n = len(router.log)
            echo = _requests_send(request)
            try:
                return fake_send(self, request, **kwargs)
            finally:
                if len(router.log) > n:
                    router.log[n]["hdrs"] = _passed_headers(dict(request.headers), True)
                    router.log[n]["wire"] = echo
        requests.Session.send = _send
    harness.install_requests_fake = install_requests_fake
