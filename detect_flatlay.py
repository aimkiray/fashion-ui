#!/usr/bin/env python3
"""Quick heuristic: detect white-background / flat-lay / mannequin product shots.

Returns JSON {"flatlay_score": float(0..1)}. A score >= 0.65 means the image is
very likely a white-background product photo (flat-lay or mannequin), in which
case Krea-2's ref_boost should be loosened so the plastic mannequin look does
not transfer onto the generated model.

The heuristic samples the four image corners and the center border ring. If a
large fraction of those pixels are near-white (>= 0.95 in sRGB after gamma) and
the interior has low saturation, the image is classified as flat-lay.
"""
import json
import sys
from pathlib import Path

try:
    from PIL import Image
    import numpy as np
except ImportError as e:
    print(json.dumps({"error": f"missing dependency: {e}"}), file=sys.stderr)
    sys.exit(2)


def detect(image_path):
    img = Image.open(image_path).convert("RGB")
    w, h = img.size
    arr = np.array(img, dtype=np.float32) / 255.0

    # Convert sRGB-ish to linear-ish luminance for thresholding
    lum = 0.2126 * arr[:, :, 0] + 0.7152 * arr[:, :, 1] + 0.0722 * arr[:, :, 2]

    border = 0.05  # fraction of min dimension treated as border
    k = max(1, int(min(w, h) * border))

    # Corner masks
    top_left = lum[:k, :k]
    top_right = lum[:k, -k:]
    bottom_left = lum[-k:, :k]
    bottom_right = lum[-k:, -k:]
    corners = np.concatenate([top_left.ravel(), top_right.ravel(),
                              bottom_left.ravel(), bottom_right.ravel()])

    # Interior (excluding the border)
    interior = lum[k:h-k, k:w-k] if h > 2*k and w > 2*k else lum

    white_corner_ratio = float(np.mean(corners >= 0.95))
    avg_corner_lum = float(np.mean(corners))
    avg_interior_lum = float(np.mean(interior))

    # Low saturation inside the interior is another flat-lay signal
    roi = arr[k:h-k, k:w-k] if h > 2*k and w > 2*k else arr
    max_rgb = roi.max(axis=2)
    min_rgb = roi.min(axis=2)
    denom = np.where(max_rgb > 0, max_rgb, 1.0)
    saturation = np.where(max_rgb > 0, (max_rgb - min_rgb) / denom, 0.0)
    low_sat_ratio = float(np.mean(saturation < 0.15))

    # Composite score: high white corners + bright interior + low saturation interior
    score = (
        0.45 * white_corner_ratio +
        0.25 * max(0.0, min(1.0, (avg_corner_lum - 0.85) / 0.15)) +
        0.15 * max(0.0, min(1.0, (avg_interior_lum - 0.80) / 0.20)) +
        0.15 * low_sat_ratio
    )
    return {
        "flatlay_score": round(score, 3),
        "white_corner_ratio": round(white_corner_ratio, 3),
        "avg_corner_lum": round(avg_corner_lum, 3),
        "avg_interior_lum": round(avg_interior_lum, 3),
        "low_sat_ratio": round(low_sat_ratio, 3),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "usage: detect_flatlay.py <image_path>"}), file=sys.stderr)
        sys.exit(1)
    path = sys.argv[1]
    if not Path(path).exists():
        print(json.dumps({"error": f"file not found: {path}"}), file=sys.stderr)
        sys.exit(1)
    print(json.dumps(detect(path)))
