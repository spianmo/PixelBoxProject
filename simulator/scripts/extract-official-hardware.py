#!/usr/bin/env python3
"""提取 Altium PDF 的元件/引脚/网络书签与 PCB 点击区域；点击区域不是制造焊盘。

依赖：pymupdf。输出可审计的原始数据，禁止将整数像素点击框当作原厂封装。
运行：python extract-official-hardware.py --source <Schematic.pdf> --out <official-data.json>
"""
import argparse
import hashlib
import json
import math
import re
from datetime import datetime, timezone
from pathlib import Path

import pymupdf as pdf


def extract(source):
    doc = pdf.open(source)
    components, nets = {}, {}
    mode = group = current = None
    for level, title, page in doc.get_toc():
        if level == 1 and page != 1:
            break
        if level == 3:
            mode = title
        elif mode == 'Components' and level == 4:
            current = title
            components[title] = {'name': title, 'pins': []}
        elif mode == 'Components' and level == 5:
            components[current]['pins'].append(title.split('-', 1)[1])
        elif mode == 'Nets' and level == 4:
            current = title
            nets[title] = []
        elif mode == 'Nets' and level == 5:
            group = title
        elif mode == 'Nets' and level == 6 and group == 'Pins':
            nets[current].append(title)

    spans = [s for b in doc[0].get_text('dict')['blocks'] for l in b.get('lines', [])
             for s in l['spans'] if s['font'] != 'Courier']
    known = {'U1': 'ESP32-S3R8', 'U2': 'XM25QH128DHIQT', 'UP1': 'AXP2101',
             'U4': 'PCF85063ATL', 'U5': 'QMI8658A', 'U6': 'ES8311', 'U7': 'ES7210',
             'U8': 'NS4150B', 'T1': 'BSS138LT1G', 'H1': 'USB Type-C',
             'J4': 'AMOLED/TP 24P', 'SD1': 'microSD', 'J1': 'GH1.25 2P',
             'TVS1': 'LTVS16H5.0ET5G'}
    for c in components.values():
        ref = next((s for s in spans if s['text'] == c['name']), None)
        if ref:
            x, y = ref['origin']
            c['schematic'] = {'x': round((x-420)/12, 3), 'y': round((295-y)/12, 3)}
            # 值的候选严格限于同基线或正下方；保留来源状态供人工核对。
            candidates = []
            for s in spans:
                dx, dy = s['origin'][0]-x, s['origin'][1]-y
                if not ((0 < dx < 22 and abs(dy) < .4) or (abs(dx) < .6 and 1 < dy < 5)):
                    continue
                if re.fullmatch(r'(?:NC|\d+(?:\.\d+)?(?:R|K|M|pF|nF|uF|nH|uH|MHz|KHz))', s['text']):
                    candidates.append((math.hypot(dx, dy), s['text']))
            # 阻容值可从邻近文字恢复；其它元件不能把邻近阻容值误作自身型号。
            c['value'] = known.get(c['name'], min(candidates)[1] if candidates and re.match(r'^[RC]\d', c['name']) else '')
            c['valueStatus'] = 'pdf-reviewed' if c['name'] in known else 'text-neighbour-unverified'
        else:
            c['value'] = known.get(c['name'], '')

    # PCB 页是放大打印；以三键间距 10mm 标定。该比例只恢复布局，不证明制造公差。
    drawings = doc[1].get_drawings()
    edges = [d for d in drawings if d['color'] and abs(d['color'][0]-.502)<.01
             and d['color'][1]<.01 and abs(d['color'][2]-.502)<.01]
    segments = []
    for d in edges:
        for item in d['items']:
            if item[0] == 'l':
                segments.append([(item[1].x, item[1].y), (item[2].x, item[2].y)])
            elif item[0] == 'c':
                p = item[1:]
                segments.append([tuple(sum(w*v[k] for w,v in zip(
                    [(1-t)**3, 3*(1-t)**2*t, 3*(1-t)*t*t, t**3], p)) for k in [0,1])
                    for t in [i/12 for i in range(13)]])
    outline = segments.pop(0)
    while segments:
        best = min((math.dist(outline[-1], s[edge]), i, edge) for i,s in enumerate(segments) for edge in [0,-1])
        distance, i, edge = best
        if distance > 1:
            raise ValueError(f'PCB 轮廓不闭合：{distance} points')
        s = segments.pop(i)
        outline.extend((s if edge==0 else list(reversed(s)))[1:])
    # 按 10mm 按钮节距与 PDF 实测印刷比例；前视=PCB 背面镜像并转向，键在右、USB 在左。
    scale = 14.05392
    cx = (min(p[0] for p in outline)+max(p[0] for p in outline))/2
    cy = (min(p[1] for p in outline)+max(p[1] for p in outline))/2
    def front(x, y):
        return [round((cy-y)/scale, 4), round((x-cx)/scale, 4)]
    outline = [front(*p) for p in outline]
    # 页 2 所有隐藏点击区域都保留；这些坐标已量化且有重复/错误区域，单独标为 recovered。
    regions = {}
    for s in doc[1].get_texttrace():
        text = ''.join(chr(c[0]) for c in s['chars'])
        if text.startswith(('CO', 'PA')):
            regions.setdefault(text, []).append(s['bbox'])
    for c in components.values():
        boxes = regions.get('CO'+c['name'], [])
        if boxes:
            b = boxes[0]
            c['pcb'] = dict(zip(['x','y'], front((b[0]+b[2])/2,(b[1]+b[3])/2)))
        pads = []
        for pin in c['pins']:
            boxes = regions.get('PA'+c['name']+'0'+pin, [])
            if boxes:
                b = boxes[0]
                px, py = front((b[0]+b[2])/2,(b[1]+b[3])/2)
                pads.append({'pin': pin, 'x': px, 'y': py})
        c['padCenters'] = pads
    # PDF 电路 pin 到 net 应当一一覆盖，重复或丢失使提取失败。
    all_pins = {c['name']+'-'+pin for c in components.values() for pin in c['pins']}
    connected = [pin for pins in nets.values() for pin in pins]
    assert len(connected) == len(set(connected)) and set(connected) == all_pins
    return {'source': Path(source).name, 'sha256': hashlib.sha256(Path(source).read_bytes()).hexdigest(),
            'extractedAt': datetime.now(timezone.utc).isoformat(),
            'status': {'netlist': 'pdf-bookmarks-exact', 'placement': 'pdf-hit-regions-recovered',
                       'footprints': 'unverified', 'routing': 'unavailable', 'drills': 'unavailable'},
            'coordinateSystem': 'mm; front view: buttons east, USB west; PDF page 2 mirrored/rotated',
            'outline': outline, 'components': list(components.values()),
            'nets': [{'name': name, 'pins': pins} for name,pins in nets.items() if pins]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    result = extract(args.source)
    Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n')
    print(json.dumps({'components': len(result['components']), 'nets': len(result['nets']),
                      'pins': sum(len(c['pins']) for c in result['components']), 'sha256': result['sha256']}))
