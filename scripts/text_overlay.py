"""Draw a caption banner at the bottom of an image.

Usage: python text_overlay.py <in.png> <out.png> <text>

Runs under C:\\ComfyUI\\python_embeded\\python.exe (bundles Pillow).
Draws a translucent dark strip at the bottom with the text centered in a
white bold font, auto-scaled to fit the image width.
"""
import sys
from PIL import Image, ImageDraw, ImageFont

FONT_DIR = "C:/Windows/Fonts"


def load_font(size):
    for name in ("arialbd.ttf", "arial.ttf", "segoeui.ttf", "tahoma.ttf"):
        try:
            return ImageFont.truetype(FONT_DIR + "/" + name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def text_w(draw, text, font):
    try:
        return draw.textlength(text, font=font)
    except TypeError:
        return font.getsize(text)[0]


def main():
    inp, outp, text = sys.argv[1], sys.argv[2], sys.argv[3]
    img = Image.open(inp).convert("RGB")
    w, h = img.size
    banner_h = max(48, h // 12)
    font_size = max(20, int(banner_h * 0.55))
    font = load_font(font_size)
    draw = ImageDraw.Draw(img)
    while font_size > 14:
        tw = text_w(draw, text, font)
        if tw <= w * 0.92:
            break
        font_size -= 2
        font = load_font(font_size)
    overlay = Image.new("RGBA", (w, banner_h), (0, 0, 0, 150))
    img.paste(overlay, (0, h - banner_h), overlay)
    draw = ImageDraw.Draw(img)
    tw = text_w(draw, text, font)
    x = (w - tw) // 2
    y = h - banner_h + (banner_h - font_size) // 2
    for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
        draw.text((x + dx, y + dy), text, font=font, fill=(0, 0, 0))
    draw.text((x, y), text, font=font, fill=(255, 255, 255))
    img.save(outp, "PNG")


main()
