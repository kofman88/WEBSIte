#!/usr/bin/env python
"""gen_rows_to_df.py — synthetic /v3/quote/klines payloads → fetcher_bingx._rows_to_df expected frames.

Run with the bot's venv (any cwd; the script chdirs into the bot):
  BOT_TOKEN_CHM=test:token ADMIN_IDS=123 python gen_rows_to_df.py > rows_to_df.json
"""
import json, math, os, sys
BOT = os.environ.get("BOT_DIR", "/home/user/MAIN_BOT/CHM_BREAKER_V4")
sys.path.insert(0, BOT); os.chdir(BOT)
import fetcher_bingx as fb

M = 60_000; H = 3_600_000; D = 86_400_000
NOW = 1_700_010_000_000  # arbitrary wall clock (ms)

def px(i, base=100.0):
    return round(base + math.sin(i / 3.0) * 5 + i * 0.013, 8)

def drow(t, i, base=100.0, key="time", vol="10", extra=None):
    o = px(i, base); h = o + 1.25; l = o - 0.75; c = o + 0.33
    r = {"open": str(o), "high": str(h), "low": str(l), "close": str(c), "volume": vol, key: t}
    if extra: r.update(extra)
    return r

def lrow(t, i, base=100.0, vol="10", extra_len=0):
    o = px(i, base); h = o + 1.25; l = o - 0.75; c = o + 0.33
    r = [t, str(o), str(h), str(l), str(c), vol]
    return r + ["x"] * extra_len

cases = []
def add(name, rows, tf, mult, now=NOW):
    cases.append({"name": name, "rows": rows, "tf": tf, "mult": mult, "now_ms": now})

# 1 clean ascending dict rows, 1h, all closed
add("clean_asc_dict_1h", [drow(NOW - (10 - i) * H, i) for i in range(10)], "1h", 1.0)
# 2 clean descending list rows (newest first) 15m
add("clean_desc_list_15m", [lrow(NOW - i * 15 * M, 20 - i) for i in range(1, 21)], "15m", 1.0)
# 3 duplicates: same time, different values; last occurrence wins
rows = [drow(NOW - 5 * H, 1), drow(NOW - 5 * H, 2), drow(NOW - 4 * H, 3), drow(NOW - 4 * H, 4, vol="99"), drow(NOW - 3 * H, 5)]
add("dup_last_wins", rows, "1h", 1.0)
# 4 forming last bar (t + tf > now)
add("forming_last_bar", [drow(NOW - 3 * H + 1, i) for i in range(3)] + [drow(NOW - H + 1, 9)], "1h", 1.0)
# 5 1000x symbol (PEPE): BingX prices / 1000, volume = v * close in BingX units
add("mult_1000", [drow(NOW - (6 - i) * H, i, base=12.5, vol="123456.78") for i in range(6)], "1h", 1000.0)
# 6 NaN volume → dropped; '' / None volume → 0
rows = [drow(NOW - 4 * H, 0, vol="nan"), drow(NOW - 3 * H, 1, vol=""), drow(NOW - 2 * H, 2, vol=None), drow(NOW - H, 3, vol="NaN")]
add("nan_volume", rows, "1h", 1.0)
# 7 out of order rows
order = [5, 2, 9, 0, 7, 1, 8, 3, 6, 4]
add("out_of_order", [drow(NOW - (10 - i) * H, i) for i in order], "1h", 1.0)
# 8 inf prices → dropped
rows = [drow(NOW - 4 * H, 0), dict(drow(NOW - 3 * H, 1), high="inf"), dict(drow(NOW - 2 * H, 2), low="-inf"), dict(drow(NOW - H, 3), open="Infinity")]
add("inf_prices", rows, "1h", 1.0)
# 9 unparsable rows skipped (strings, None price, missing key, nonsense types)
rows = [drow(NOW - 5 * H, 0), dict(drow(NOW - 4 * H, 1), open="abc"), dict(drow(NOW - 3 * H, 2), close=None),
        {"open": "1", "high": "2", "low": "0.5", "time": NOW - 2 * H}, 42, "str", None, [], [NOW - H], [NOW - H, "1", "2"],
        drow(NOW - H, 7)]
add("unparsable_skipped", rows, "1h", 1.0)
# 10 mixed dict/list
rows = [drow(NOW - 6 * H, 0), lrow(NOW - 5 * H, 1), drow(NOW - 4 * H, 2, key="openTime"), lrow(NOW - 3 * H, 3, extra_len=3), drow(NOW - 2 * H, 4, key="T")]
add("mixed_dict_list", rows, "1h", 1.0)
# 11 all forming → None
add("all_forming", [drow(NOW - 10 * M, 0), drow(NOW + 5 * M, 1)], "1h", 1.0)
# 12 empty → None
add("empty", [], "1h", 1.0)
# 13 boundary: t + tf == now → closed; t + tf == now + 1 → forming
add("boundary_closed", [drow(NOW - H, 0), drow(NOW - H + 1, 1)], "1h", 1.0)
# 14 mult 10000 / 1000000
add("mult_10000", [lrow(NOW - (4 - i) * H, i, base=0.0042, vol="5e6") for i in range(4)], "1h", 10000.0)
add("mult_1e6", [lrow(NOW - (4 - i) * H, i, base=1.7, vol="3.5e9") for i in range(4)], "1h", 1000000.0)
# 15 tf variants
for tf, ms in [("4h", 4 * H), ("1d", D), ("1w", 7 * D), ("1M", 31 * D), ("5m", 5 * M), ("30m", 30 * M)]:
    add(f"tf_{tf}", [drow(NOW - (5 - i) * ms, i) for i in range(5)] + [drow(NOW - ms + 1, 9)], tf, 1.0)
# unknown tf → 3600000 default
add("tf_unknown", [drow(NOW - 2 * H, 0), drow(NOW - 50 * M, 1), drow(NOW - 59 * M - 59_999, 2)], "xyz", 1.0)
# 16 volume formats
rows = [drow(NOW - 6 * H, 0, vol=7), drow(NOW - 5 * H, 1, vol=7.5), drow(NOW - 4 * H, 2, vol="1e3"), drow(NOW - 3 * H, 3, vol=" 12 "),
        drow(NOW - 2 * H, 4, vol="1_000"), drow(NOW - H, 5, vol="-3")]
add("volume_formats", rows, "1h", 1.0)
# 17 time formats
rows = [drow(str(NOW - 6 * H), 0), drow(float(NOW - 5 * H), 1), drow(str(NOW - 4 * H) + ".5", 2), drow(" " + str(NOW - 3 * H) + " ", 3),
        drow(True, 4), drow(NOW - 2 * H + 0.9, 5), drow("1e3", 6), drow(None, 7, extra={"openTime": NOW - H})]
add("time_formats", rows, "1h", 1.0)
# 18 time key precedence: '' time → openTime; None time → T; time=0 valid; unparsable time → row skipped (no fallback)
rows = [dict(drow(NOW - 4 * H, 0), time="", openTime=NOW - 4 * H), {"open": "1", "high": "2", "low": "0.5", "close": "1.5", "volume": "1", "time": None, "T": NOW - 3 * H},
        drow(0, 1), {"open": "1", "high": "2", "low": "0.5", "close": "1.5", "volume": "1", "time": "abc", "openTime": NOW - 2 * H}]
add("time_key_precedence", rows, "1h", 1.0)
# 19 extra keys ignored
add("extra_keys", [drow(NOW - (3 - i) * H, i, extra={"foo": "bar", "symbol": "X"}) for i in range(3)], "1h", 1.0)
# 20 zero close → volume 0; negative prices kept
rows = [dict(drow(NOW - 3 * H, 0), close="0"), dict(drow(NOW - 2 * H, 1), low="-5"), drow(NOW - H, 2)]
add("zero_close", rows, "1h", 1.0)
# 21 mult 1.0 / 0 / None → no scaling
add("mult_one", [lrow(NOW - 2 * H, 0), lrow(NOW - H, 1)], "1h", 1.0)
add("mult_zero", [lrow(NOW - 2 * H, 0), lrow(NOW - H, 1)], "1h", 0)
add("mult_none", [lrow(NOW - 2 * H, 0), lrow(NOW - H, 1)], "1h", None)
# 22 tiny prices precision with mult
add("tiny_prices_mult", [lrow(NOW - (8 - i) * H, i, base=0.00001234, vol="98765432.1") for i in range(8)], "1h", 1000.0)
# 23 big payload 1440 rows 15m with one dup and the last forming
rows = [drow(NOW - (300 - i) * 15 * M + 7 * M, i) for i in range(300)]
rows.append(dict(rows[150], close="55.5"))
add("big_300_15m", rows, "15m", 1.0)
# 24 only duplicates of a forming bar → None
add("only_forming_dups", [drow(NOW - 10 * M, 0), drow(NOW - 10 * M, 1)], "1h", 1.0)
# 25 nan in every closed row → empty (not None)
add("all_nan_closed", [dict(drow(NOW - 3 * H, 0), open="nan"), dict(drow(NOW - 2 * H, 1), high="nan")], "1h", 1.0)
# 26 bool and numeric prices
rows = [dict(drow(NOW - 3 * H, 0), open=True, high=2, low=0.5, close=1), drow(NOW - 2 * H, 1)]
add("bool_numeric_prices", rows, "1h", 1.0)
# 27 list rows with fewer than 5 elements skipped, exactly 5 ok (volume 0)
rows = [[NOW - 4 * H, "1", "2"], [NOW - 3 * H, "1", "2", "0.5", "1.5"], [NOW - 2 * H, "1", "2", "0.5", "1.5", "7"]]
add("list_lengths", rows, "1h", 1.0)
# 28 unsorted with forming in the middle of the input
rows = [drow(NOW - 10 * M, 0), drow(NOW - 3 * H, 1), drow(NOW - 2 * H, 2), drow(NOW + 3 * H, 3)]
add("forming_mid_input", rows, "1h", 1.0)
# 29 whitespace / signed numeric strings
rows = [dict(drow(NOW - 2 * H, 0), open=" +101.5 ", high="1.1e2", low="+99", close=".5"), dict(drow(NOW - H, 1), open="5.", close="-0")]
add("signed_strings", rows, "1h", 1.0)
# 30 payload with time far in the past and future mix on 1d
rows = [drow(NOW - 400 * D, 0), drow(NOW - 2 * D, 1), drow(NOW - D, 2), drow(NOW, 3), drow(NOW + D, 4)]
add("past_future_1d", rows, "1d", 1.0)
# 31 underscore / hex-like strings (python float grammar: single underscores between digits only)
rows = [dict(drow(NOW - 4 * H, 0), open="1_0"), dict(drow(NOW - 3 * H, 1), open="0x10"), dict(drow(NOW - 2 * H, 2), open="1__0"),
        dict(drow(NOW - H, 3), open="_10"), dict(drow(NOW - 5 * H, 4), open="10_"), dict(drow(NOW - 6 * H, 5), open="1_0.5_5e1_0")]
add("underscore_hex", rows, "1h", 1.0)
# 32 time as bool False → int(False)=0 (valid), volume bool
rows = [dict(drow(NOW - 2 * H, 0), volume=True), dict(drow(False, 1))]
add("bool_time_volume", rows, "1h", 1.0)
# 33 exotic float strings
rows = [dict(drow(NOW - 6 * H, 0), open="1e"), dict(drow(NOW - 5 * H, 1), open="e5"), dict(drow(NOW - 4 * H, 2), open="1.5.5"),
        dict(drow(NOW - 3 * H, 3), open="+-1"), dict(drow(NOW - 2 * H, 4), open="１２"), dict(drow(NOW - H, 5), open="\t 7E-2 \n"),
        dict(drow(NOW - 7 * H, 6), open="- 1"), dict(drow(NOW - 8 * H, 7), open="INFINITY"), dict(drow(NOW - 9 * H, 8), open="-NaN")]
add("exotic_float_strings", rows, "1h", 1.0)
# 34 int strings for time with signs / underscores
rows = [dict(drow("+" + str(NOW - 3 * H), 0)), dict(drow("1_700_000_000_000", 1)), dict(drow("1__700000000000", 2)), dict(drow("-5", 3)), dict(drow("٣", 4))]
add("int_string_forms", rows, "1h", 1.0)

out = []
for c in cases:
    df = fb._rows_to_df(c["rows"], c["tf"], c["mult"], now_ms=c["now_ms"])
    if df is None:
        exp = None
    else:
        exp = {
            "t": [int(x) for x in (df.index.astype("int64") // 10**6).tolist()],
            "o": df["open"].tolist(), "h": df["high"].tolist(), "l": df["low"].tolist(),
            "c": df["close"].tolist(), "v": df["volume"].tolist(),
        }
    out.append(dict(c, expected=exp))
json.dump({"now_ms": NOW, "cases": out}, sys.stdout)
