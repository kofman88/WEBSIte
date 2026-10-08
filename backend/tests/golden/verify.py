"""Sanity checks on the generated golden set (structure, counts, alignment, samples)."""
import json, os, glob, math
G = os.path.dirname(os.path.abspath(__file__))
TF_MS = {"15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
T_END = 1767225600000  # 2026-01-01T00:00:00Z
files = sorted(glob.glob(os.path.join(G, "candles", "*_*.json")))
print("candle files:", len(files))
bad = 0
for f in files:
    d = json.load(open(f))
    tf = d["tf"]; bars = d["bars"]
    ms = [b[0] for b in bars]
    assert all(m % TF_MS[tf] == 0 for m in ms), f
    assert ms[-1] + TF_MS[tf] == T_END, (f, ms[-1])
    assert all(ms[i + 1] - ms[i] == TF_MS[tf] for i in range(len(ms) - 1)), f
    for b in bars:
        o, h, l, c, v = b[1:]
        if not (l <= min(o, c) <= max(o, c) <= h and v > 0 and l > 0):
            bad += 1
print("bars with inconsistent OHLCV:", bad)
idx = json.load(open(os.path.join(G, "candles", "index.json")))
print("fixtures:", len(idx["fixtures"]), "regimes:", sorted({f["regime"] for f in idx["fixtures"]}))
tot = {}
for strat in ("levels", "smc", "volume"):
    d = json.load(open(os.path.join(G, "expected", f"{strat}.json")))
    n_sig = 0; n_err = 0; n_warn = 0; swept = set()
    for sym, fx in d["fixtures"].items():
        for v, r in fx.items():
            n_sig += r["n_signals"]; n_err += len(r["errors"]); n_warn += len(r["warnings"])
            swept.add((r["swept"][0], r["swept"][1], r["n_swept"]))
            assert r["signal_bars"] == [s["i"] for s in r["signals"]]
            for s in r["signals"]:
                for k in ("direction", "entry", "sl", "tp1", "tp2", "tp3"):
                    assert k in s and s[k] is not None, (strat, sym, v, s["i"], k)
                assert s["direction"] in ("LONG", "SHORT")
                if s["direction"] == "LONG":
                    assert s["sl"] < s["entry"] < s["tp1"] < s["tp2"] < s["tp3"], (strat, sym, v, s["i"])
                else:
                    assert s["sl"] > s["entry"] > s["tp1"] > s["tp2"] > s["tp3"], (strat, sym, v, s["i"])
    tot[strat] = n_sig
    print(f"{strat:7s} signals={n_sig:5d} errors={n_err} warnings={n_warn} swept={sorted(swept)} "
          f"size={os.path.getsize(os.path.join(G, 'expected', f'{strat}.json')) // 1024} KB variants={list(d['variants'])}")
    # one sample
    for sym, fx in d["fixtures"].items():
        if fx["default"]["signals"]:
            s = fx["default"]["signals"][0]
            keys = [k for k in s if k not in ("reasons", "human_explanation", "narrative", "confirmations")]
            print("   sample", sym, {k: s[k] for k in keys[:14]})
            break
sa = json.load(open(os.path.join(G, "expected", "smc_analysis.json")))
print("smc_analysis fixtures:", len(sa["fixtures"]), "bars/fixture:", len(next(iter(sa["fixtures"].values()))),
      "size KB:", os.path.getsize(os.path.join(G, "expected", "smc_analysis.json")) // 1024)
summ = json.load(open(os.path.join(G, "summary.json")))
print("summary:", {k: summ["strategies"][k]["signals"] for k in summ["strategies"]}, "determinism:", summ.get("determinism_check"))
assert all(v >= 20 for v in tot.values()), tot
print("OK")
