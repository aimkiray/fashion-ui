import sys
from PIL import Image

# Fit src to the exact target pixel size (tw x th) without distortion.
#
# Strategy (head-protecting):
# 1. Exact size            -> pass-through copy.
# 2. Aspect already right  -> trim the few excess pixels and Lanczos-resize
#                             (covers the "off by a few px" upstream drift).
# 3. Aspect mismatch       -> crop to the target aspect with a TOP-BIASED
#                             anchor (only 25% of the excess is removed from
#                             the top, 75% from the bottom) so the subject's
#                             head survives; then Lanczos-resize to target.
#                             Used when an upstream coerces the requested
#                             size to its own supported set.
#
# Both trim and resize may upscale slightly for few-px drifts — that is the
# sanctioned correction path; content-bearing crops are never centered.

TOP_BIAS = 0.25


def crop_to_aspect(im, target, head_protect=True):
    W, H = im.size
    cur = W / H
    if abs(cur - target) < 1e-4:
        return im
    if cur > target:  # too wide -> trim width (sides), keep full height
        nw = max(1, int(round(H * target)))
        x = (W - nw) // 2
        return im.crop((x, 0, x + nw, H))
    # too tall -> trim height; keep the head: bias the trim to the bottom
    nh = max(1, int(round(W / target)))
    excess = H - nh
    if head_protect:
        top = int(round(excess * TOP_BIAS))
    else:
        top = excess // 2
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
