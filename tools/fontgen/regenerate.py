"""Generate Chinese firmware fonts from the existing OFL-licensed simulator assets."""
from pathlib import Path
from fontgen import parse_charset, parse_outline, scale_font, serialize

root = Path(__file__).resolve().parents[2]
sources = root / 'simulator/src/renderer/src/device-sim/sandbox/fonts'
output = root / 'firmware/components/hal_display/fonts'
wanted = parse_charset('ascii,gb2312,punct,range:4E00-9FFF')
for size, fallback_size, scale, name in [(12, 8, 1, 'pixel12'), (8, 12, 2, 'pixel16')]:
    def source(n):
        return str(sources / f'fusion-pixel-{n}px-proportional-zh_hans.otf.woff2')
    font = parse_outline(source(size), wanted, size)
    font.glyphs.update(parse_outline(source(fallback_size), wanted - set(font.glyphs), size).glyphs)
    data = serialize(scale_font(font, scale))
    (output / f'{name}.pxf').write_bytes(data)
    print(f'{name}: {len(font.glyphs)} glyphs, {len(data)} bytes')
