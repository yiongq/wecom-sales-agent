#!/usr/bin/env python3
"""生成企微链接卡片的缩略图（assets/proposal-thumb.png）与网页分享封面（public/share-cover.png）。

设计约束来自它的真实使用场景，而不是"好看"：
  · 卡片里实际只有 ~60px 见方，任何小字都糊成一团 —— 所以只放一个「云」字，不放品牌全称。
  · 微信卡片底色是浅灰/白（深色模式下是深灰），深色缩略图会变成一块突兀的黑方块 ——
    所以用方案书页同款的暖白底 #f6f5f2，边缘一圈金线呼应品牌色。
  · 同一张图还要当网页分享封面用，所以留足内边距，被裁成圆角/圆形也不伤主体。

改图后重新跑：python3 assets/make-thumb.py
"""
from PIL import Image, ImageDraw, ImageFont

SIZE = 240                 # 企微 media/upload 用；卡片里会缩到 ~60px
BG = (246, 245, 242)       # --bg 暖白，与方案书页一致
GOLD = (183, 138, 62)      # --gold
GOLD_SOFT = (243, 236, 221)  # --gold-soft
FONT = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def build() -> Image.Image:
    img = Image.new("RGB", (SIZE, SIZE), BG)
    d = ImageDraw.Draw(img)

    # 内圈浅金底 + 一圈金线：小尺寸下靠这个形状让缩略图有"品牌感"，
    # 不靠文字（文字在 60px 下不可读）
    pad = 18
    d.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=26, fill=GOLD_SOFT)
    d.rounded_rectangle([pad, pad, SIZE - pad, SIZE - pad], radius=26, outline=GOLD, width=3)

    # 「云」字占满内圈，缩到 60px 仍能认出
    f = ImageFont.truetype(FONT, 116)
    box = d.textbbox((0, 0), "云", font=f)
    w, h = box[2] - box[0], box[3] - box[1]
    d.text(((SIZE - w) / 2 - box[0], (SIZE - h) / 2 - box[1]), "云", font=f, fill=GOLD)
    return img


if __name__ == "__main__":
    im = build()
    im.save("assets/proposal-thumb.png", optimize=True)
    im.save("public/share-cover.png", optimize=True)
    print(f"已生成 {SIZE}x{SIZE}：assets/proposal-thumb.png + public/share-cover.png")
