import sys
from PIL import Image, ImageOps

def main():
    if len(sys.argv) < 5:
        sys.exit(1)
    src = sys.argv[1]
    dst = sys.argv[2]
    tw = int(sys.argv[3])
    th = int(sys.argv[4])
    
    with Image.open(src) as im:
        if im.width == tw and im.height == th:
            im.save(dst)
            return
        fitted = ImageOps.fit(im, (tw, th), Image.Resampling.LANCZOS)
        fitted.save(dst)

if __name__ == '__main__':
    main()
