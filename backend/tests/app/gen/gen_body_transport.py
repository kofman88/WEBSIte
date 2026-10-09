"""gen_body_transport.py — tests/app/fixtures/body_transport.json (bodyTransport.test.js): how the
bot's aiohttp server (the Mini App API exactly as bot.py serves it: web.Application() with the
default client_max_size = 1 MiB, miniapp_api.register) answers request bodies at the transport
edges — the 1 MiB cap (Content-Length and chunked), Content-Encoding gzip / deflate / raw deflate /
br / zstd / unknown / upper case / a list, a corrupt gzip, a gzip bomb, a body on a GET, an
oversized body without a valid initData, a body on an unknown path.

The probe route is POST /miniapp/api/lang (h_lang: `_read_body` → lang) — `{"ok": true, "lang": "en"}`
means the body was read, `bad_request lang` that `_read_body` returned {}. Requests are written
byte for byte over a socket (Connection: close) to an in-process TestServer; the initData check is
bypassed (`_tg_user` → a fixed Telegram user when X-Telegram-Init-Data is "ok", else None); the
user manager is a fake (no DB write).

    cd /home/user/MAIN_BOT/CHM_BREAKER_V4
    BOT_TOKEN_CHM=test:token ADMIN_IDS=123 <python 3.11 venv>/bin/python -I \
        <site>/backend/tests/app/gen/gen_body_transport.py [OUT]
    rm -f /home/user/MAIN_BOT/CHM_BREAKER_V4/signal_registry.json
"""
import asyncio, base64, gzip, json, os, sys, time, zlib

BOT = os.environ.get("GOLDEN_BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
HERE = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("BOT_TOKEN_CHM", "test:token")
os.environ.setdefault("ADMIN_IDS", "123")
sys.dont_write_bytecode = True
sys.path.insert(0, BOT)
os.chdir(BOT)
import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer
import miniapp_api as api
from user_manager import UserSettings

MiB = 1024 * 1024
OK_BODY = b'{"lang":"en"}'


def padded(total):
    """A JSON object with lang=en of exactly `total` bytes."""
    head, tail = b'{"lang":"en","pad":"', b'"}'
    return head + b"x" * (total - len(head) - len(tail)) + tail


def gz(b):
    return gzip.compress(b, mtime=0)


def zl(b):
    return zlib.compress(b)


def raw_deflate(b):
    c = zlib.compressobj(wbits=-15)
    return c.compress(b) + c.flush()


def chunked(b, size=65536):
    out = b""
    for i in range(0, len(b), size):
        part = b[i:i + size]
        out += f"{len(part):x}\r\n".encode() + part + b"\r\n"
    return out + b"0\r\n\r\n"


# name, method, path, headers (list), body bytes, auth, transfer ('length' | 'chunked' | 'none')
CASES = [
    ("plain", "POST", "/lang", [("Content-Type", "application/json")], OK_BODY, True, "length"),
    ("exactly_1MiB", "POST", "/lang", [], padded(MiB), True, "length"),
    ("1MiB_plus_1", "POST", "/lang", [], padded(MiB + 1), True, "length"),
    ("2MiB", "POST", "/lang", [], padded(2 * MiB), True, "length"),
    ("1MiB_plus_1_chunked", "POST", "/lang", [], padded(MiB + 1), True, "chunked"),
    ("exactly_1MiB_chunked", "POST", "/lang", [], padded(MiB), True, "chunked"),
    ("2MiB_no_auth", "POST", "/lang", [], padded(2 * MiB), False, "length"),
    ("2MiB_get_help", "GET", "/help", [], padded(2 * MiB), True, "length"),
    ("2MiB_unknown_path", "POST", "/nope", [], padded(2 * MiB), True, "length"),
    ("gzip", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY), True, "length"),
    ("gzip_upper", "POST", "/lang", [("Content-Encoding", "GZIP")], gz(OK_BODY), True, "length"),
    ("gzip_corrupt", "POST", "/lang", [("Content-Encoding", "gzip")], b"hello world", True, "length"),
    ("gzip_bomb", "POST", "/lang", [("Content-Encoding", "gzip")], gz(padded(3 * MiB)), True, "length"),
    ("gzip_exactly_1MiB", "POST", "/lang", [("Content-Encoding", "gzip")], gz(padded(MiB)), True, "length"),
    ("gzip_1MiB_plus_1", "POST", "/lang", [("Content-Encoding", "gzip")], gz(padded(MiB + 1)), True, "length"),
    ("deflate_zlib", "POST", "/lang", [("Content-Encoding", "deflate")], zl(OK_BODY), True, "length"),
    ("deflate_raw", "POST", "/lang", [("Content-Encoding", "deflate")], raw_deflate(OK_BODY), True, "length"),
    ("br_plain_bytes", "POST", "/lang", [("Content-Encoding", "br")], OK_BODY, True, "length"),
    ("zstd_plain_bytes", "POST", "/lang", [("Content-Encoding", "zstd")], OK_BODY, True, "length"),
    ("unknown_encoding", "POST", "/lang", [("Content-Encoding", "foo")], OK_BODY, True, "length"),
    ("identity", "POST", "/lang", [("Content-Encoding", "identity")], OK_BODY, True, "length"),
    ("x_gzip", "POST", "/lang", [("Content-Encoding", "x-gzip")], gz(OK_BODY), True, "length"),
    ("gzip_list", "POST", "/lang", [("Content-Encoding", "gzip, identity")], gz(OK_BODY), True, "length"),
    ("gzip_list_plain", "POST", "/lang", [("Content-Encoding", "gzip, identity")], OK_BODY, True, "length"),
    ("gzip_padded_value", "POST", "/lang", [("Content-Encoding", " gzip ")], gz(OK_BODY), True, "length"),
    ("gzip_get_help", "GET", "/help", [("Content-Encoding", "gzip")], b"not gzip", True, "length"),
    ("plain_no_auth", "POST", "/lang", [], OK_BODY, False, "length"),
    ("gzip_no_trailer", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY)[:-8], True, "length"),
    ("gzip_half_trailer", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY)[:-3], True, "length"),
    ("gzip_bad_crc", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY)[:-8] + b"\0\0\0\0" + gz(OK_BODY)[-4:], True, "length"),
    ("gzip_trailing_garbage", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY) + b"garbage!", True, "length"),
    ("gzip_two_members", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY) + gz(b"xyz"), True, "length"),
    ("gzip_cut_stream", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY)[:12], True, "length"),
    ("gzip_br_no_body", "POST", "/lang", [("Content-Encoding", "br")], b"", True, "length"),
    ("deflate_truncated", "POST", "/lang", [("Content-Encoding", "deflate")], zl(OK_BODY)[:-4], True, "length"),
    ("deflate_trailing_garbage", "POST", "/lang", [("Content-Encoding", "deflate")], zl(OK_BODY) + b"garbage!", True, "length"),
    ("deflate_raw_truncated", "POST", "/lang", [("Content-Encoding", "deflate")], raw_deflate(OK_BODY)[:-2], True, "length"),
    ("deflate_empty_stream", "POST", "/lang", [("Content-Encoding", "deflate")], zl(b""), True, "length"),
    ("gzip_empty_body", "POST", "/lang", [("Content-Encoding", "gzip")], b"", True, "chunked"),
    ("gzip_chunked", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY), True, "chunked"),
    ("zstd_no_auth", "POST", "/lang", [("Content-Encoding", "zstd")], OK_BODY, False, "length"),
    ("zstd_unknown_path", "POST", "/nope", [("Content-Encoding", "zstd")], OK_BODY, True, "length"),
    ("br_get_no_body", "GET", "/help", [("Content-Encoding", "br")], b"", True, "none"),
    ("deflate_get_no_body", "GET", "/help", [("Content-Encoding", "deflate")], b"", True, "none"),
    ("deflate_empty_length", "POST", "/lang", [("Content-Encoding", "deflate")], b"", True, "length"),
    ("gzip_1024_members", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY) + gz(b"") * 1023, True, "length"),
    ("gzip_1025_members", "POST", "/lang", [("Content-Encoding", "gzip")], gz(OK_BODY) + gz(b"") * 1024, True, "length"),
    ("deflate_1024_members", "POST", "/lang", [("Content-Encoding", "deflate")], zl(OK_BODY) + zl(b"") * 1023, True, "length"),
    ("deflate_1025_members", "POST", "/lang", [("Content-Encoding", "deflate")], zl(OK_BODY) + zl(b"") * 1024, True, "length"),
    ("gzip_split_members", "POST", "/lang", [("Content-Encoding", "gzip")], gz(b'{"lang":') + gz(b'"en"}'), True, "length"),
    ("deflate_split_members", "POST", "/lang", [("Content-Encoding", "deflate")], zl(b'{"lang":') + zl(b'"en"}'), True, "length"),
    ("raw_split_members", "POST", "/lang", [("Content-Encoding", "deflate")], raw_deflate(b'{"lang":') + raw_deflate(b'"en"}'), True, "length"),
]


def gz_header(flags, extra=b"", name=b"", comment=b"", bad_hcrc=False, cm=8):
    """A gzip member header with the RFC 1952 optional fields."""
    h = bytes([0x1F, 0x8B, cm, flags]) + b"\0\0\0\0" + b"\0\xff"
    if flags & 4:
        h += len(extra).to_bytes(2, "little") + extra
    if flags & 8:
        h += name + b"\0"
    if flags & 16:
        h += comment + b"\0"
    if flags & 2:
        crc = zlib.crc32(h) & 0xFFFF
        h += (crc ^ (1 if bad_hcrc else 0)).to_bytes(2, "little")
    return h


def gz_member(data, **kw):
    return gz_header(**kw) + raw_deflate(data) + (zlib.crc32(data) & 0xFFFFFFFF).to_bytes(4, "little") + (len(data) & 0xFFFFFFFF).to_bytes(4, "little")


def fuzz_cases():
    """Deterministic variants around the decoder edges: header fields, cuts at every region, garbage tails."""
    import random
    rnd = random.Random(20261009)
    out = []
    payloads = [OK_BODY, b'{"lang":"en","x":"' + b"y" * 300 + b'"}', b'{"lang": "en"}', b'[1]', b'{"lang":"ru"}']
    for flags, kw in [(0, {}), (4, {"extra": b"ab"}), (8, {"name": b"f.json"}), (16, {"comment": b"c"}), (2, {}), (30, {"extra": b"z", "name": b"n", "comment": b"c"}),
                      (2, {"bad_hcrc": True}), (0x20, {}), (0, {"cm": 7})]:
        out.append((f"gzip_hdr_{flags}_{'_'.join(sorted(kw))}", "gzip", gz_member(OK_BODY, flags=flags, **kw)))
    for i in range(60):
        enc = rnd.choice(["gzip", "deflate", "deflate_raw"])
        data = rnd.choice(payloads)
        if enc == "gzip":
            body = gz_member(data, flags=rnd.choice([0, 8, 2]), name=b"x") if rnd.random() < 0.5 else gz(data)
        elif enc == "deflate":
            body = zl(data)
        else:
            body = raw_deflate(data)
        kind = rnd.choice(["cut", "tail", "flip", "tail_member", "cut_member"])
        if kind == "cut":
            body = body[:rnd.randrange(0, len(body) + 1)]
        elif kind == "tail":
            body = body + bytes(rnd.randrange(256) for _ in range(rnd.randrange(1, 6)))
        elif kind == "flip":
            j = rnd.randrange(len(body))
            body = body[:j] + bytes([body[j] ^ (1 << rnd.randrange(8))]) + body[j + 1:]
        elif kind == "tail_member":
            body = body + (gz(b"") if enc == "gzip" else zl(b"") if enc == "deflate" else raw_deflate(b""))
        else:
            second = gz(b" ") if enc == "gzip" else zl(b" ") if enc == "deflate" else raw_deflate(b" ")
            body = body + second[:rnd.randrange(0, len(second))]
        out.append((f"fuzz_{i:02d}_{enc}_{kind}", "gzip" if enc == "gzip" else "deflate", body))
    return [(name, "POST", "/lang", [("Content-Encoding", enc)], body, True, "length") for name, enc, body in out]


CASES += fuzz_cases()


class FakeUM:
    async def get_or_create(self, user_id, username="", language_code=""):
        u = UserSettings(user_id=user_id)
        u.sub_plan, u.sub_status, u.sub_expires = "free", "active", time.time() + 365 * 86400
        u.lang = "ru"
        return u

    async def save(self, user):
        return None


def _tg_user(request):
    if request.headers.get("X-Telegram-Init-Data", "") == "ok":
        return {"id": 1, "username": "u1", "first_name": "U"}
    return None


async def send(host, port, method, path, headers, body, auth, transfer):
    reader, writer = await asyncio.open_connection(host, port)
    lines = [f"{method} /miniapp/api{path} HTTP/1.1", f"Host: {host}:{port}", "Connection: close"]
    if auth:
        lines.append("X-Telegram-Init-Data: ok")
    for k, v in headers:
        lines.append(f"{k}: {v}")
    if transfer == "length":
        lines.append(f"Content-Length: {len(body)}")
        payload = body
    elif transfer == "chunked":
        lines.append("Transfer-Encoding: chunked")
        payload = chunked(body)
    else:
        payload = b""
    data = ("\r\n".join(lines) + "\r\n\r\n").encode("latin-1") + payload

    async def write():
        try:
            writer.write(data)
            await writer.drain()
        except (ConnectionError, OSError):
            pass

    async def read():
        chunks = []
        try:
            while True:
                c = await reader.read(65536)
                if not c:
                    break
                chunks.append(c)
        except (ConnectionError, OSError):
            pass
        return b"".join(chunks)

    _, raw = await asyncio.gather(write(), read())
    try:
        writer.close()
    except Exception:
        pass
    head, _, rest = raw.partition(b"\r\n\r\n")
    hl = head.decode("latin-1").split("\r\n")
    status = int(hl[0].split(" ")[1]) if hl and hl[0] else 0
    hdrs = {}
    for ln in hl[1:]:
        k, _, v = ln.partition(":")
        hdrs[k.strip().lower()] = v.strip()
    if hdrs.get("transfer-encoding") == "chunked":
        out, buf = b"", rest
        while True:
            n_s, _, buf = buf.partition(b"\r\n")
            n = int(n_s or b"0", 16)
            if not n:
                break
            out += buf[:n]
            buf = buf[n + 2:]
        rest = out
    text = rest.decode("utf-8", "replace")
    try:
        js = json.loads(text)
    except ValueError:
        js = None
    return {"status": status, "content_type": hdrs.get("content-type", ""), "json": js, "text": None if js is not None else text}


async def main():
    api._tg_user = _tg_user
    app = web.Application()
    api.register(app, bot=None, um=FakeUM(), scanner=None)
    server = TestServer(app, host="127.0.0.1")
    await server.start_server()
    out = []
    try:
        for name, method, path, headers, body, auth, transfer in CASES:
            api._RATE.clear()
            res = await send(server.host, server.port, method, path, headers, body, auth, transfer)
            out.append({
                "name": name, "method": method, "path": path, "headers": headers, "auth": auth, "transfer": transfer,
                "body_b64": base64.b64encode(body).decode() if len(body) < 65536 else None,
                "body_gen": None if len(body) < 65536 else describe(name), "body_len": len(body),
                "expected": res,
            })
    finally:
        await server.close()
    doc = {"python": sys.version.split()[0], "aiohttp": aiohttp.__version__, "client_max_size": MiB, "cases": out}
    dst = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.path.join(HERE, "..", "fixtures", "body_transport.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=True, indent=1)
    print(len(out), "cases")


def describe(name):
    """How the JS side rebuilds a large body (the fixture stays small)."""
    return {
        "exactly_1MiB": {"padded": MiB}, "1MiB_plus_1": {"padded": MiB + 1}, "2MiB": {"padded": 2 * MiB},
        "1MiB_plus_1_chunked": {"padded": MiB + 1}, "exactly_1MiB_chunked": {"padded": MiB},
        "2MiB_no_auth": {"padded": 2 * MiB}, "2MiB_get_help": {"padded": 2 * MiB}, "2MiB_unknown_path": {"padded": 2 * MiB},
        "gzip_bomb": {"padded": 3 * MiB, "gzip": True}, "gzip_exactly_1MiB": {"padded": MiB, "gzip": True},
        "gzip_1MiB_plus_1": {"padded": MiB + 1, "gzip": True},
    }[name]


asyncio.run(main())
