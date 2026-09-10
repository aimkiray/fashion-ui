import sys
from PIL import Image

# Fit src to the exact target pixel size (tw x th) without distortion.
#
# Strategy (content-aware, head-protecting):
# 1. Exact size            -> pass-through copy.
# 2. Aspect already right  -> trim the few excess pixels and Lanczos-resize
#                             (covers the "off by a few px" upstream drift).
# 3. Aspect mismatch       -> crop to the target aspect with a CONTENT-AWARE
#                             vertical anchor:
#   - Primary: per-column scan. Each column's background is its own top
#     HEAD_BG_ROWS mean; the first row deviating > threshold (max-channel) is
#     that column's content start. The 10th percentile over all columns is the
#     top of the subject envelope — robust to smooth head curves (which
#     adjacent-row mean steps cannot see: they detect the shoulder line
#     instead) and to narrow subjects (48-col mean dilution).
#   - Degenerate columns resolve protectively: uniform column -> no content
#     (excluded); content from row 0 -> 0.
#   - Secondary: adjacent-row step scan (detects body/shoulder lines) used
#     when the column scan is uninformative.
#   - The crop window never passes above the detected envelope top minus a
#     safety margin; when the vertical excess is large (> 15% of frame height
#     — upstream coerced the size hard), the crop is anchored at the frame
#     top (zero top crop) and the whole excess is taken from below: the
#     prompt's headroom instruction is what guarantees the composition then.
# Prompt-level headroom ("at least 12% of the frame height above the hair")
# keeps this crop small in the first place.

TOP_BIAS = 0.25
SAFETY_RATIO = 0.02       # keep >= 2% of frame height as margin beyond content
CONTENT_THRESHOLD = 12    # adjacent-row step threshold
SECOND_PASS_THRESHOLD = 5 # relaxed second pass, requires longer runs
LARGE_EXCESS_RATIO = 0.15 # vertical excess above this -> anchor crop at top
COLS = 64
HEAD_BG_ROWS = 8
COLUMN_THRESHOLD = 25     # max-channel deviation for the per-column scan


def _column_content_top(im, threshold=COLUMN_THRESHOLD):
    """Top of the subject envelope: per-column first content row vs the
    column's own top-edge background, 10th percentile over columns. Returns
    0 when the subject touches the top edge, None when the image is uniform."""
    W, H = im.size
    if H < HEAD_BG_ROWS * 2:
        return None
    rgb = im.convert('RGB')
    small = rgb.resize((COLS, H))
    px = small.load()
    firsts = []
    for x in range(COLS):
        bg = [0.0, 0.0, 0.0]
        for y in range(HEAD_BG_ROWS):
            c = px[x, y]
            bg[0] += c[0]; bg[1] += c[1]; bg[2] += c[2]
        bg = [v / HEAD_BG_ROWS for v in bg]
        first = None
        for y in range(H):
            c = px[x, y]
            if max(abs(c[0] - bg[0]), abs(c[1] - bg[1]), abs(c[2] - bg[2])) > threshold:
                first = y
                break
        firsts.append(H if first is None else first)  # 均匀列 = 纯背景
    firsts.sort()
    q = firsts[int(len(firsts) * 0.1)]
    return None if q >= H else q


def _row_blocks(im, cols=COLS, blocks=6):
    """Yield per-row lists of per-block mean RGB (rows at full resolution)."""
    rgb = im.convert('RGB')
    small = rgb.resize((cols, im.size[1]))
    px = small.load()
    bw = cols // blocks
    for y in range(im.size[1]):
        row = []
        for bi in range(blocks):
            r = g = b = 0
            for x in range(bi * bw, (bi + 1) * bw):
                c = px[x, y]
                r += c[0]; g += c[1]; b += c[2]
            row.append((r / bw, g / bw, b / bw))
        yield row


def _scan_content_edge(im, threshold, min_consecutive, from_bottom):
    """First sustained adjacent-row color step (block max, per-channel max).
    Secondary detector: finds body/shoulder lines; it cannot see the smooth
    top of a head, so it is never used to anchor the head-protecting crop."""
    rows = list(_row_blocks(im))
    H = len(rows)
    rng = range(H - 2, -1, -1) if from_bottom else range(1, H)
    prev_idx = (H - 1) if from_bottom else 0
    run = 0
    for y in rng:
        step = 0
        for bi in range(6):
            for k in range(3):
                d = abs(rows[y][bi][k] - rows[prev_idx][bi][k])
                if d > step:
                    step = d
        if step > threshold:
            run += 1
            if run >= min_consecutive:
                return y
        else:
            run = 0
        prev_idx = y
    return None


def detect_content_top(im):
    """Head-envelope top row, or None when nothing informative is detected."""
    top = _column_content_top(im)
    if top is not None:
        return top
    return _scan_content_edge(im, CONTENT_THRESHOLD, 2, from_bottom=False)


def crop_to_aspect(im, target, head_protect=True):
    """Crop im to the target aspect. Vertical anchor is content-aware when
    head_protect is on (see module docstring)."""
    W, H = im.size
    cur = W / H
    if abs(cur - target) < 1e-4:
        return im
    if cur > target:  # too wide -> trim width (sides), keep full height
        nw = max(1, int(round(H * target)))
        x = (W - nw) // 2
        return im.crop((x, 0, x + nw, H))

    # too tall -> vertical crop with content-aware anchoring
    nh = max(1, int(round(W / target)))
    excess = H - nh
    ideal_top = int(round(excess * TOP_BIAS))

    head_cap = excess   # 头顶保护上限（默认允许偏置）
    feet_cap = 0        # 脚部保护下限（默认不保留）
    if head_protect:
        try:
            content_top = detect_content_top(im)
            feet_bottom = _scan_content_edge(im, SECOND_PASS_THRESHOLD, 3, from_bottom=True)
        except Exception as exc:
            print(f"[crop_to_canvas] content detection failed ({exc}); "
                  f"using fixed {TOP_BIAS:.0%} top bias.", file=sys.stderr)
            content_top = feet_bottom = None
        if content_top is not None:
            head_cap = max(0, min(excess, content_top - max(4, int(round(H * SAFETY_RATIO)))))
            if content_top < int(0.02 * H):
                print(f"[crop_to_canvas] content top at y={content_top} — background "
                      f"likely busy at top; vertical crop taken from feet.",
                      file=sys.stderr)
        if feet_bottom is not None and feet_bottom > int(0.2 * H):
            feet_cap = max(0, min(excess, feet_bottom + max(4, int(round(H * SAFETY_RATIO))) - nh))

    # 大裁剪量（上游强制大改尺寸）：顶部零裁剪，构图由 headroom 指令保证
    if excess > int(0.15 * H):
        if head_cap > 0:
            print(f"[crop_to_canvas] large vertical excess ({excess}px = "
                  f"{excess / H:.0%} of frame) — anchoring crop at frame top "
                  f"to protect the head; excess taken from feet.",
                  file=sys.stderr)
        head_cap = 0

    # 头部硬保护优先；在头部保护内尽量少裁脚
    top = max(0, min(head_cap, max(ideal_top, feet_cap)))
    print(f"[crop_to_canvas] vertical trim {excess}px -> top {top}px "
          f"(head cap {head_cap}px, feet cap {feet_cap}px, ideal bias {ideal_top}px).",
          file=sys.stderr)
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
