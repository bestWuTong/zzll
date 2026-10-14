#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
由站点 Logo 生成网页图标（favicon 等）。

用法：
    cd zzll
    python scripts/make_icons.py

输入：
    ../Logo.ico    （工作区根目录的 Logo，256x256 PNG 封装的 ICO）

输出：
    favicon.ico                      多尺寸（16/32/48），浏览器标签页图标
    assets/favicon-32.png            现代浏览器优先使用的 PNG 图标
    assets/apple-touch-icon.png      180x180，iOS「添加到主屏幕」用

Logo 换新后重跑本脚本即可。
"""

import os
import struct
import sys

try:
    from PIL import Image, ImageEnhance, ImageFilter
except ImportError:
    print('[错误] 需要 Pillow：python -m pip install Pillow', file=sys.stderr)
    sys.exit(1)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))   # zzll/
ROOT_DIR = os.path.dirname(BASE_DIR)                                     # 政治理论排坑速练/
SRC_CANDIDATES = [
    os.path.join(ROOT_DIR, 'Logo.ico'),
    os.path.join(BASE_DIR, 'Logo.ico'),
]
ASSETS_DIR = os.path.join(BASE_DIR, 'assets')


def find_source():
    for p in SRC_CANDIDATES:
        if os.path.isfile(p):
            return p
    return None


def main():
    src = find_source()
    if not src:
        print('[错误] 未找到 Logo.ico，查找过：\n  ' + '\n  '.join(SRC_CANDIDATES), file=sys.stderr)
        return 1

    os.makedirs(ASSETS_DIR, exist_ok=True)

    img = Image.open(src)
    # 统一成 RGBA，保留透明通道
    img = img.convert('RGBA')
    print('[输入] %s  %dx%d' % (src, img.width, img.height))

    if img.width < 256 or img.height < 256:
        print('[警告] 源图小于 256x256，放大后可能发虚')

    def render(size, boost=False):
        """LANCZOS 缩放；小尺寸补一点对比/饱和 + 锐化，抵消缩图后的发糊"""
        out = img.resize((size, size), Image.LANCZOS)
        if boost:
            out = ImageEnhance.Color(out).enhance(1.16)
            out = ImageEnhance.Contrast(out).enhance(1.10)
            out = out.filter(ImageFilter.UnsharpMask(radius=0.8, percent=130, threshold=3))
        return out

    # 1) 多尺寸 ICO（标签页 / 书签 / 任务栏）；小尺寸用自己处理过的帧
    ico_path = os.path.join(BASE_DIR, 'favicon.ico')
    base48 = render(48, boost=True)
    frames = [render(32, boost=True), render(16, boost=True)]
    base48.save(ico_path, format='ICO', sizes=[(16, 16), (32, 32), (48, 48)],
                append_images=frames)
    with open(ico_path, 'rb') as fp:
        head = fp.read(6)
    _, _, count = struct.unpack('<HHH', head)
    print('[输出] %s（%d 个尺寸，%.1f KB）' % (ico_path, count, os.path.getsize(ico_path) / 1024))

    # 2) PNG 图标（现代浏览器优先用 PNG，缩放更干净）
    def save_png(size, name, boost=False):
        out = render(size, boost)
        path = os.path.join(ASSETS_DIR, name)
        out.save(path, format='PNG', optimize=True)
        print('[输出] %s（%dx%d，%.1f KB）' % (path, size, size, os.path.getsize(path) / 1024))

    save_png(32, 'favicon-32.png', boost=True)
    save_png(180, 'apple-touch-icon.png')

    print('[完成] 图标已生成，index.html 中的 <link rel="icon"> 已指向这些文件')
    return 0


if __name__ == '__main__':
    sys.exit(main())
