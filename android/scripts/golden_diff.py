#!/usr/bin/env python3
"""Golden screenshot diff gate for the Ragent Android client.

Compares candidate captures against the committed baselines in app/screenshots/
and fails (exit 1) if any image's pixel difference exceeds the threshold.

Metrics per image:
  diff%  : fraction of pixels where any channel differs by more than EPS
           (default 8/255, covers anti-aliasing jitter)
  meanΔ  : mean absolute channel difference (0..255)
  maxΔ   : maximum channel difference (0..255)

Gate rule (default): FAIL if diff% > 0.10.

The same-device noise floor is 0.00% (deterministic states), so 0.10% is a
tight catch-any-real-change threshold with a small margin for cross-device
font/AA variance. Tune via --threshold; the value is the approved gate.

Usage:
  golden_diff.py --baseline app/screenshots --candidate <capture-dir> \
      [--threshold 0.10] [--out build/golden-diff]
"""
import argparse
import os
import sys

from PIL import Image

EPS = 8  # per-channel tolerance (0..255) for a "changed" pixel


def diff_images(a_path: str, b_path: str):
    a = Image.open(a_path).convert("RGB")
    b = Image.open(b_path).convert("RGB")
    if a.size != b.size:
        return None  # hard failure: dimensions differ
    da, db = a.load(), b.load()
    w, h = a.size
    px = w * h
    changed = 0
    sum_delta = 0
    max_delta = 0
    diff_img = Image.new("RGB", (w, h), (0, 0, 0))
    dd = diff_img.load()
    for y in range(h):
        for x in range(w):
            pa = da[x, y]
            pb = db[x, y]
            md = max(abs(pa[i] - pb[i]) for i in range(3))
            if md > EPS:
                changed += 1
                dd[x, y] = (255, 0, 0)  # mark changed pixels red
            sum_delta += md
            max_delta = max(max_delta, md)
    return {
        "diff_pct": 100.0 * changed / px,
        "mean_delta": sum_delta / (px * 3),
        "max_delta": max_delta,
        "diff_img": diff_img,
        "size": (w, h),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--baseline", required=True, help="committed baselines dir")
    ap.add_argument("--candidate", required=True, help="captured PNGs dir")
    ap.add_argument("--threshold", type=float, default=0.10,
                    help="max allowed diff%% (pixels > EPS); default 0.10")
    ap.add_argument("--out", default="build/golden-diff", help="diff output dir")
    args = ap.parse_args()

    baseline_names = sorted(f for f in os.listdir(args.baseline) if f.endswith(".png"))
    if not baseline_names:
        print("ERROR: no baselines found in", args.baseline)
        return 2
    os.makedirs(args.out, exist_ok=True)

    failures = []
    for name in baseline_names:
        candidate = os.path.join(args.candidate, name)
        if not os.path.exists(candidate):
            print(f"FAIL {name:28s} candidate missing")
            failures.append(name)
            continue
        result = diff_images(os.path.join(args.baseline, name), candidate)
        if result is None:
            print(f"FAIL {name:28s} size mismatch (baseline {os.path.getsize(os.path.join(args.baseline, name))}B)")
            failures.append(name)
            continue
        result["diff_img"].save(os.path.join(args.out, f"{name}.diff.png"))
        ok = result["diff_pct"] <= args.threshold
        status = "PASS" if ok else "FAIL"
        print(f"{status} {name:28s} diff%={result['diff_pct']:.4f} "
              f"meanΔ={result['mean_delta']:.3f} maxΔ={result['max_delta']} "
              f"({result['size'][0]}x{result['size'][1]})")
        if not ok:
            failures.append(name)

    print("-" * 70)
    if failures:
        print(f"GOLDEN DIFF FAILED: {len(failures)} image(s) above threshold "
              f"{args.threshold:.2f}% -> diff images in {args.out}")
        return 1
    print(f"GOLDEN DIFF OK: all {len(baseline_names)} baselines within "
          f"threshold {args.threshold:.2f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
