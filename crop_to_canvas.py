import sys
from PIL import Image

# Fit src to the exact target pixel size (tw x th) without distortion.
#
# Strategy (content-aware, head-protecting):
# 1. Exact size            -> pass-through copy.
# 2. Aspect already right  -> trim the few excess pixels and Lanczos-resize
#                             (covers the "off by a few px" upstream drift).
# 3. Aspect mismatch       -> crop to the target aspect. The vertical crop
#                             anchor is CONTENT-AWARE: detect the first row
#                             that departs from the background (the top of
#                             the subject's head) and never crop into it plus
#                             a small safety margin. All excess height that
#                             cannot come from above the head is removed
#                             from below (feet). If detection fails, fall
#                             back to a 25% top bias.
# Prompt-level headroom (requested separately in the generation prompt)
# keeps this crop small in the first place.

TOP_BIAS = 0.25
SAFETY_RATIO = 0.02       # keep >= 2% of frame height above the detected head
CONTENT_THRESHOLD = 16    # per-channel mean abs diff vs background (0-255)


def find_content_top(im, threshold=12):
    """Row (in im's own pixel scale) where the subject starts, detected as the
    first sharp step in adjacent-row mean color. Step detection is used
    instead of background-color estimation: when the subject reaches near the
    top edge, corner sampling would sample subject pixels and invert the
    detection. Width is downsampled for speed but rows stay at FULL
    resolution — thin headroom slivers (a few px between the hair and the
    frame edge) must remain visible. Busy backgrounds degrade to None (caller
    falls back to the fixed bias)."""
    W, H = im.size
    if H < 8:
        return None
    rgb = im.convert('RGB')
    small = rgb.resize((48, H))
    sw = 48
    px = small.load()

    prev = None
    for y in range(H):
        r = g = b = 0
        for x in range(sw):
            c = px[x, y]
            r += c[0]; g += c[1]; b += c[2]
        cur = (r / sw, g / sw, b / sw)
        if prev is not None:
            diff = (abs(cur[0] - prev[0]) + abs(cur[1] - prev[1]) + abs(cur[2] - prev[2])) / 3
            if diff > threshold:
                # 首个阶跃若落在画面底部 20%，说明内容从第 0 行就开始
                # （如头顶贴边构图）——此时顶部没有任何可裁空间
                if y > int(0.8 * H):
                    return 0
                return y
        prev = cur
    return None


def crop_to_aspect(im, target, head_protect=True):
    """Crop im to the target aspect. For height trims the anchor is
    content-aware when head_protect is on: the crop never reaches above the
    detected top of the subject (minus a safety margin)."""
    W, H = im.size
    cur = W / H
    if abs(cur - target) < 1e-4:
        return im
    if cur > target:  # too wide -> trim width (sides), keep full height
        nw = max(1, int(round(H * target)))
        x = (W - nw) // 2
        return im.crop((x, 0, x + nw, H))

    # too tall -> trim height, protecting the head
    nh = max(1, int(round(W / target)))
    excess = H - nh
    ideal_top = int(round(excess * TOP_BIAS))
    top = ideal_top
    note = f"fixed {TOP_BIAS:.0%} top bias"
    if head_protect:
        try:
            content_top = find_content_top(im)
        except Exception as exc:
            content_top = None
            print(f"[crop_to_canvas] content-top detection failed ({exc}); "
                  f"using fixed bias.", file=sys.stderr)
        if content_top is not None:
            safety = max(4, int(round(H * SAFETY_RATIO)))
            # never crop into the head: top cut cannot pass above it
            max_top = max(0, min(excess, content_top - safety))
            top = max(0, min(ideal_top, max_top))
            note = (f"content top at y={content_top}, "
                    f"top cut {top}px (ideal bias {ideal_top}px, "
                    f"head-safe limit {max_top}px)")
    print(f"[crop_to_canvas] vertical trim {excess}px -> {note}", file=sys.stderr)
    return im.crop((0, top, W, top + nh))


def main():
    if len(sys.argv) < 5:
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    tw, th = int(sys.argv[3]), int(sys.argv[4])
    if tw <= 0 or th <= 0:
        sys.exit(1)

    with Image.open(src) as im:
        im.load()
        # Respect EXIF rotation for JPEG sources before any geometric op
        try:
            from PIL import ImageOps
            transposed = ImageOps.exif_transpose(im)
            if transposed is not None:
                im = transposed
        except Exception as exc:
            # 静默吞掉会导致头部偏置裁剪偏向错误一端且无日志——必须透出
            print(f"[crop_to_canvas] exif_transpose failed ({exc}); "
                  f"proceeding without rotation — crop anchor may be wrong.",
                  file=sys.stderr)
        W, H = im.size
        if W == tw and H == th:
            if src != dst:
                im.save(dst)
            return

        target = tw / th
        cur = W / H
        coerced = abs(cur - target) >= 0.01
        fitted = crop_to_aspect(im, target)
        if coerced:
            # Upstream ignored the requested size — surface it loudly.
            print(
                f"[crop_to_canvas] upstream size {W}x{H} does not match the "
                f"requested {tw}x{th}; applied head-protecting crop to "
                f"{fitted.size[0]}x{fitted.size[1]} then resize.",
                file=sys.stderr,
            )
        if fitted.size != (tw, th):
            scale = max(tw / fitted.size[0], th / fitted.size[1])
            if scale > 1.2:
                print(
                    f"[crop_to_canvas] upscale factor {scale:.2f}x exceeds 1.2 — "
                    f"upstream returned an unexpectedly small image; output may look soft.",
                    file=sys.stderr,
                )
            fitted = fitted.resize((tw, th), Image.Resampling.LANCZOS)
        # Preserve the embedded ICC profile through the re-encode when present
        save_kwargs = {}
        icc = im.info.get('icc_profile')
        if icc:
            save_kwargs['icc_profile'] = icc
        fitted.save(dst, **save_kwargs)


if __name__ == '__main__':
    main()
