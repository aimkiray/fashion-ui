import sys
from PIL import Image

# Center-crop src to the exact rw:rh aspect ratio (no upscale, max pixels kept).
# The upstream image API coerces sizes to its supported set (e.g. everything
# portrait becomes 1024x1536), so we restore the user-selected ratio locally.

def main():
    if len(sys.argv) < 5:
        sys.exit(1)
    src, dst = sys.argv[1], sys.argv[2]
    rw, rh = int(sys.argv[3]), int(sys.argv[4])
    if rw <= 0 or rh <= 0:
        sys.exit(1)
    with Image.open(src) as im:
        im.load()
        W, H = im.size
        target = rw / rh
        cur = W / H
        if abs(cur - target) < 0.01:
            if src != dst:
                im.save(dst)
            return
        if cur > target:  # too wide -> crop width, keep full height
            nw = max(1, int(round(H * target)))
            x = (W - nw) // 2
            box = (x, 0, x + nw, H)
        else:             # too tall -> crop height, keep full width
            nh = max(1, int(round(W / target)))
            y = (H - nh) // 2
            box = (0, y, W, y + nh)
        im.crop(box).save(dst)

main()
