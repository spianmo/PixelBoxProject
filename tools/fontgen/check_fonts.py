"""Validate embedded PXF coverage and real glyph bitmaps without firmware hardware."""
import struct
from pathlib import Path
from PIL import Image
from fontgen import charset_gb2312

ROOT = Path(__file__).resolve().parents[2]
REQUIRED = '正在聆听思考回答唤醒休息联网设置账号密码保存退出小川你好'


def check(path):
    data = path.read_bytes()
    assert data[:4] == b'PXFN'
    height = data[5]
    assert data[6] <= height
    count, pool_size = struct.unpack_from('<II', data, 8)
    pool_at = 16 + count * 8
    assert len(data) == pool_at + pool_size
    glyphs = {}
    previous = -1
    for i in range(count):
        cp, width, advance, offset = struct.unpack_from('<HBBI', data, 16 + i * 8)
        assert cp > previous and width > 0 and advance > 0
        previous = cp
        size = ((width + 7) // 8) * height
        assert offset + size <= pool_size
        glyphs[cp] = data[pool_at + offset:pool_at + offset + size]
    for char in REQUIRED:
        assert ord(char) in glyphs, f'{path.name}: missing U+{ord(char):04X}'
        assert any(glyphs[ord(char)]), f'{path.name}: blank U+{ord(char):04X}'
        assert glyphs[ord(char)] != glyphs[ord('?')], f'{path.name}: fallback for {char}'
    missing = charset_gb2312(False) - glyphs.keys()
    assert not missing, f'{path.name}: missing {len(missing)} GB2312 characters'
    assert count > 14000
    phrase = '正在聆听 思考中 小川正在回答'
    preview = Image.new('RGB', (len(phrase) * height, height), '#080b0b')
    x = 0
    for char in phrase:
        index = next(i for i in range(count) if struct.unpack_from('<H', data, 16 + i * 8)[0] == ord(char))
        _, width, advance, _ = struct.unpack_from('<HBBI', data, 16 + index * 8)
        bitmap = glyphs[ord(char)]
        row_bytes = (width + 7) // 8
        for y in range(height):
            for col in range(width):
                if bitmap[y * row_bytes + col // 8] & (128 >> (col % 8)):
                    preview.putpixel((x + col, y), (238, 242, 238))
        x += advance
    preview.crop((0, 0, x, height)).resize((x * 4, height * 4), Image.Resampling.NEAREST).save(ROOT / 'firmware/build' / (path.stem + '-check.png'))
    print(f'{path.name}: {count} glyphs, {len(data)} bytes, complete GB2312 and assistant text')


for name in ('pixel12.pxf', 'pixel16.pxf'):
    check(ROOT / 'firmware/components/hal_display/fonts' / name)
