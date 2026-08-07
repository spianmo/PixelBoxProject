/**
 * OpenSCAD 语言支持(Monaco):Monarch 高亮 + 内置模块/函数补全(中文文档)+ hover
 *
 * 服务硬件工程的 design/enclosure.scad(外壳即代码,即时渲染见 openscadWorker)。
 * OpenSCAD 无 LSP 可离线复用,这里以内置符号表提供「语法提示」:
 * - 补全:全部内置 3D/2D 图元、变换、布尔、拉伸、数学函数与特殊变量($fn 等),
 *   snippet 带参数占位,documentation 为中文用法说明(suggest 详情面板默认展开,
 *   见 EditorHost 的 _setDetailsVisible)
 * - hover:光标下内置符号给出同一份文档
 * - 用户自定义 module/function:按当前文件正则扫描补进建议(轻量,无语义分析)
 */
// 直接 import monaco 包根(与 monacoSetup 同一实例):本模块被 monacoSetup 调用,
// 反向 import { monaco } from './monacoSetup' 会成环
import * as monaco from 'monaco-editor'

export const OPENSCAD_LANGUAGE_ID = 'openscad'

/** 内置符号文档:name → { sig, doc, snippet } */
interface BuiltinDoc {
  /** 签名展示,如 cube(size, center) */
  sig: string
  /** 中文说明(markdown) */
  doc: string
  /** snippet 插入体(不含尾随分号,块类符号带 {} ) */
  snippet: string
  kind: 'module' | 'function' | 'keyword' | 'variable'
}

// 文档以官方 cheatsheet 为纲,面向"外壳建模"场景给出常用参数与注意事项
const BUILTINS: Record<string, BuiltinDoc> = {
  // ---------------- 3D 图元 ----------------
  cube: {
    sig: 'cube(size, center = false)',
    doc: '长方体。`size` 为标量(正方体)或 `[x, y, z]`;`center=true` 时以原点为中心,否则位于第一卦限。\n\n```scad\ncube([46, 46, 22.5]);\n```',
    snippet: 'cube([${1:x}, ${2:y}, ${3:z}]${4:, center = false})',
    kind: 'module'
  },
  sphere: {
    sig: 'sphere(r | d)',
    doc: '球体。`r` 半径或 `d` 直径;配合 `$fn` 控制面数(如 `$fn = 64` 更圆滑,渲染更慢)。\n\n```scad\nsphere(r = 5, $fn = 64);\n```',
    snippet: 'sphere(r = ${1:5}, \\$fn = ${2:64})',
    kind: 'module'
  },
  cylinder: {
    sig: 'cylinder(h, r | r1/r2 | d | d1/d2, center = false)',
    doc: '圆柱/圆台。`h` 高;`r` 上下同半径,`r1`/`r2` 分别为底/顶半径(可做倒角圆台);`center=true` 沿 Z 居中。\n\n```scad\ncylinder(h = 8, d = 5.3, $fn = 48); // 按键圆孔\n```',
    snippet: 'cylinder(h = ${1:10}, r = ${2:5}${3:, center = false}, \\$fn = ${4:48})',
    kind: 'module'
  },
  polyhedron: {
    sig: 'polyhedron(points, faces, convexity)',
    doc: '任意多面体。`points` 顶点数组,`faces` 每个面的顶点索引(从外侧看逆时针)。复杂外形优先用布尔组合,确需异形壳体再用它。',
    snippet: 'polyhedron(points = [${1}], faces = [${2}])',
    kind: 'module'
  },
  // ---------------- 2D 图元(配合拉伸) ----------------
  square: {
    sig: 'square(size, center = false)',
    doc: '2D 矩形。`size` 标量或 `[x, y]`。常与 `linear_extrude` 组合成板件。',
    snippet: 'square([${1:x}, ${2:y}]${3:, center = false})',
    kind: 'module'
  },
  circle: {
    sig: 'circle(r | d)',
    doc: '2D 圆。与 `linear_extrude`/`rotate_extrude` 组合;`$fn` 控制边数。',
    snippet: 'circle(r = ${1:5}, \\$fn = ${2:64})',
    kind: 'module'
  },
  polygon: {
    sig: 'polygon(points, paths)',
    doc: '2D 多边形。`points` 顶点表;`paths` 可选(带孔轮廓时给外圈+内圈索引)。',
    snippet: 'polygon(points = [${1}])',
    kind: 'module'
  },
  text: {
    sig: 'text(text, size, font, halign, valign)',
    doc: '2D 文字(刻字/丝印)。注意:WASM 内置字体有限,复杂字体可能缺字;刻中文前先渲染确认。',
    snippet: 'text("${1:PixelBox}", size = ${2:6}, halign = "center", valign = "center")',
    kind: 'module'
  },
  // ---------------- 变换 ----------------
  translate: {
    sig: 'translate([x, y, z])',
    doc: '平移子节点。\n\n```scad\ntranslate([0, 0, 2]) cube(5);\n```',
    snippet: 'translate([${1:0}, ${2:0}, ${3:0}]) ',
    kind: 'module'
  },
  rotate: {
    sig: 'rotate([ax, ay, az]) | rotate(a, [vx, vy, vz])',
    doc: '旋转子节点(角度制)。`rotate([0, 0, 90])` 绕 Z 转 90°;或 `rotate(45, [1, 1, 0])` 绕任意轴。',
    snippet: 'rotate([${1:0}, ${2:0}, ${3:90}]) ',
    kind: 'module'
  },
  scale: {
    sig: 'scale([x, y, z])',
    doc: '缩放子节点。`scale([1, 1, 0.5])` 压扁一半。',
    snippet: 'scale([${1:1}, ${2:1}, ${3:1}]) ',
    kind: 'module'
  },
  resize: {
    sig: 'resize([x, y, z], auto = false)',
    doc: '把子节点缩放到指定外形尺寸;某轴为 0 且 `auto=true` 时按比例跟随。',
    snippet: 'resize([${1:0}, ${2:0}, ${3:0}], auto = ${4:true}) ',
    kind: 'module'
  },
  mirror: {
    sig: 'mirror([x, y, z])',
    doc: '按法向量所在平面镜像。`mirror([1, 0, 0])` 左右镜像。',
    snippet: 'mirror([${1:1}, ${2:0}, ${3:0}]) ',
    kind: 'module'
  },
  multmatrix: {
    sig: 'multmatrix(m)',
    doc: '对子节点施加 4×4 仿射矩阵(高级用法:剪切等)。',
    snippet: 'multmatrix(m = ${1:m}) ',
    kind: 'module'
  },
  color: {
    sig: 'color("name" | [r, g, b, a])',
    doc: '预览着色(仅预览,导出的 STL 无颜色)。\n\n```scad\ncolor("white", 0.5) cube(5); // 半透明便于看内部\n```',
    snippet: 'color("${1:white}"${2:, 1.0}) ',
    kind: 'module'
  },
  offset: {
    sig: 'offset(r | delta, chamfer = false)',
    doc: '2D 轮廓外扩/内缩。`r` 圆角过渡,`delta` 直角过渡;正值外扩、负值内缩(做壁厚/间隙)。',
    snippet: 'offset(r = ${1:1}) ',
    kind: 'module'
  },
  hull: {
    sig: 'hull() { ... }',
    doc: '子节点的凸包。两端放圆柱再 hull 可得圆角长条(圆角外壳的常用招)。\n\n```scad\nhull() { translate([-10, 0, 0]) cylinder(h = 5, r = 3); translate([10, 0, 0]) cylinder(h = 5, r = 3); }\n```',
    snippet: 'hull() {\n\t$0\n}',
    kind: 'module'
  },
  minkowski: {
    sig: 'minkowski() { ... }',
    doc: '闵可夫斯基和:方壳 + 小球 = 全圆角壳(渲染慢,调参阶段建议注释掉)。',
    snippet: 'minkowski() {\n\t$0\n}',
    kind: 'module'
  },
  // ---------------- 布尔 ----------------
  union: {
    sig: 'union() { ... }',
    doc: '并集(并排书写默认即隐式并集,显式包裹便于配合 difference)。',
    snippet: 'union() {\n\t$0\n}',
    kind: 'module'
  },
  difference: {
    sig: 'difference() { ... }',
    doc: '差集:第一个子节点减去其余全部 —— 挖孔/开槽/掏空的核心。\n\n```scad\ndifference() {\n  cube([46, 46, 22.5]);            // 外壳\n  translate([2, 2, 2]) cube([42, 42, 22]); // 内腔\n}\n```',
    snippet: 'difference() {\n\t${1:// 主体}\n\t${2:// 要减去的}\n}',
    kind: 'module'
  },
  intersection: {
    sig: 'intersection() { ... }',
    doc: '交集:仅保留全部子节点的公共部分(截取/限位)。',
    snippet: 'intersection() {\n\t$0\n}',
    kind: 'module'
  },
  // ---------------- 拉伸 / 投影 ----------------
  linear_extrude: {
    sig: 'linear_extrude(height, twist, scale, center)',
    doc: '把 2D 轮廓沿 Z 拉伸成 3D。`twist` 扭转角、`scale` 顶部缩放(可做锥形)。',
    snippet: 'linear_extrude(height = ${1:10}) ',
    kind: 'module'
  },
  rotate_extrude: {
    sig: 'rotate_extrude(angle = 360)',
    doc: '把 X≥0 半平面上的 2D 轮廓绕 Z 旋转成回转体(旋钮/密封圈)。',
    snippet: 'rotate_extrude(angle = ${1:360}, \\$fn = ${2:64}) ',
    kind: 'module'
  },
  projection: {
    sig: 'projection(cut = false)',
    doc: '3D → 2D 投影。`cut=true` 取 Z=0 截面(用于出激光切割轮廓)。',
    snippet: 'projection(cut = ${1:false}) ',
    kind: 'module'
  },
  surface: {
    sig: 'surface(file, center, invert)',
    doc: '从高度图文件生成表面(WASM 环境无外部文件系统,外壳工程一般用不到)。',
    snippet: 'surface(file = "${1:heightmap.dat}")',
    kind: 'module'
  },
  // ---------------- 结构 ----------------
  module: {
    sig: 'module name(params) { ... }',
    doc: '定义可复用形体(类似函数,但产出几何)。参数可带默认值;体内用 `children()` 引用调用处的子节点。',
    snippet: 'module ${1:name}(${2}) {\n\t$0\n}',
    kind: 'keyword'
  },
  function: {
    sig: 'function name(params) = expr;',
    doc: '定义纯计算函数(返回数值/向量,不产出几何)。\n\n```scad\nfunction inner_w(w, wall) = w - 2 * wall;\n```',
    snippet: 'function ${1:name}(${2}) = ${3:expr};',
    kind: 'keyword'
  },
  children: {
    sig: 'children() | children(i)',
    doc: '在 module 体内引用调用处传入的子节点(全部或第 i 个)。',
    snippet: 'children()',
    kind: 'module'
  },
  include: {
    sig: 'include <file.scad>',
    doc: '引入其他 .scad(其顶层语句会执行)。IDE 的即时渲染以当前文件为入口,include 的相对路径按 design/ 解析。',
    snippet: 'include <${1:common.scad}>',
    kind: 'keyword'
  },
  use: {
    sig: 'use <file.scad>',
    doc: '仅引入 module/function 定义(顶层几何不执行)。',
    snippet: 'use <${1:lib.scad}>',
    kind: 'keyword'
  },
  'for': {
    sig: 'for (i = [start : step : end]) ...',
    doc: '循环生成(隐式并集)。\n\n```scad\nfor (i = [0 : 2]) translate([i * 10, 0, 0]) cylinder(h = 8, d = 5.3); // 三个按键孔\n```',
    snippet: 'for (${1:i} = [${2:0} : ${3:2}]) ',
    kind: 'keyword'
  },
  intersection_for: {
    sig: 'intersection_for (i = range) ...',
    doc: '循环 + 交集(普通 for 是并集,此变体逐次求交)。',
    snippet: 'intersection_for (${1:i} = [${2:0} : ${3:2}]) ',
    kind: 'keyword'
  },
  'if': {
    sig: 'if (cond) ... else ...',
    doc: '条件生成几何(常配布尔开关变量,如 `show_lid = true;`)。',
    snippet: 'if (${1:cond}) {\n\t$0\n}',
    kind: 'keyword'
  },
  'let': {
    sig: 'let (a = expr, ...) ...',
    doc: '局部绑定变量后对子表达式求值。',
    snippet: 'let (${1:a} = ${2:1}) ',
    kind: 'keyword'
  },
  echo: {
    sig: 'echo(...)',
    doc: '打印调试信息(输出显示在外壳页签的渲染日志里)。',
    snippet: 'echo(${1:"val"}, ${2:x})',
    kind: 'module'
  },
  assert: {
    sig: 'assert(cond, message)',
    doc: '断言:条件不成立则中止渲染并报错(校验壁厚/尺寸约束)。',
    snippet: 'assert(${1:cond}, "${2:说明}")',
    kind: 'module'
  },
  // ---------------- 常用数学 / 工具函数 ----------------
  abs: { sig: 'abs(x)', doc: '绝对值。', snippet: 'abs(${1:x})', kind: 'function' },
  sign: { sig: 'sign(x)', doc: '符号(-1/0/1)。', snippet: 'sign(${1:x})', kind: 'function' },
  sin: { sig: 'sin(deg)', doc: '正弦(角度制)。', snippet: 'sin(${1:deg})', kind: 'function' },
  cos: { sig: 'cos(deg)', doc: '余弦(角度制)。', snippet: 'cos(${1:deg})', kind: 'function' },
  tan: { sig: 'tan(deg)', doc: '正切(角度制)。', snippet: 'tan(${1:deg})', kind: 'function' },
  asin: { sig: 'asin(x)', doc: '反正弦,返回角度。', snippet: 'asin(${1:x})', kind: 'function' },
  acos: { sig: 'acos(x)', doc: '反余弦,返回角度。', snippet: 'acos(${1:x})', kind: 'function' },
  atan: { sig: 'atan(x)', doc: '反正切,返回角度。', snippet: 'atan(${1:x})', kind: 'function' },
  atan2: { sig: 'atan2(y, x)', doc: '两参反正切(全象限),返回角度。', snippet: 'atan2(${1:y}, ${2:x})', kind: 'function' },
  floor: { sig: 'floor(x)', doc: '向下取整。', snippet: 'floor(${1:x})', kind: 'function' },
  ceil: { sig: 'ceil(x)', doc: '向上取整。', snippet: 'ceil(${1:x})', kind: 'function' },
  round: { sig: 'round(x)', doc: '四舍五入。', snippet: 'round(${1:x})', kind: 'function' },
  sqrt: { sig: 'sqrt(x)', doc: '平方根。', snippet: 'sqrt(${1:x})', kind: 'function' },
  pow: { sig: 'pow(base, exp)', doc: '幂。', snippet: 'pow(${1:base}, ${2:exp})', kind: 'function' },
  exp: { sig: 'exp(x)', doc: 'e 的 x 次幂。', snippet: 'exp(${1:x})', kind: 'function' },
  ln: { sig: 'ln(x)', doc: '自然对数。', snippet: 'ln(${1:x})', kind: 'function' },
  log: { sig: 'log(x)', doc: '常用对数(底 10)。', snippet: 'log(${1:x})', kind: 'function' },
  min: { sig: 'min(a, b, ...) | min(vector)', doc: '最小值。', snippet: 'min(${1:a}, ${2:b})', kind: 'function' },
  max: { sig: 'max(a, b, ...) | max(vector)', doc: '最大值。', snippet: 'max(${1:a}, ${2:b})', kind: 'function' },
  norm: { sig: 'norm(vector)', doc: '向量模长。', snippet: 'norm(${1:v})', kind: 'function' },
  cross: { sig: 'cross(a, b)', doc: '向量叉积。', snippet: 'cross(${1:a}, ${2:b})', kind: 'function' },
  len: { sig: 'len(x)', doc: '向量/字符串长度。', snippet: 'len(${1:x})', kind: 'function' },
  concat: { sig: 'concat(a, b, ...)', doc: '拼接向量。', snippet: 'concat(${1:a}, ${2:b})', kind: 'function' },
  str: { sig: 'str(a, b, ...)', doc: '拼接为字符串。', snippet: 'str(${1:a}, ${2:b})', kind: 'function' },
  chr: { sig: 'chr(code)', doc: '码点转字符。', snippet: 'chr(${1:65})', kind: 'function' },
  ord: { sig: 'ord(char)', doc: '字符转码点。', snippet: 'ord("${1:A}")', kind: 'function' },
  search: { sig: 'search(match, target, ...)', doc: '查找(向量/字符串)。', snippet: 'search(${1:m}, ${2:t})', kind: 'function' },
  lookup: { sig: 'lookup(key, table)', doc: '按键在二维表中线性插值取值。', snippet: 'lookup(${1:key}, ${2:table})', kind: 'function' },
  rands: { sig: 'rands(min, max, count, seed)', doc: '随机数向量(给 seed 才可复现)。', snippet: 'rands(${1:0}, ${2:1}, ${3:1})', kind: 'function' },
  is_undef: { sig: 'is_undef(x)', doc: '是否未定义。', snippet: 'is_undef(${1:x})', kind: 'function' },
  is_num: { sig: 'is_num(x)', doc: '是否数值。', snippet: 'is_num(${1:x})', kind: 'function' },
  is_bool: { sig: 'is_bool(x)', doc: '是否布尔。', snippet: 'is_bool(${1:x})', kind: 'function' },
  is_string: { sig: 'is_string(x)', doc: '是否字符串。', snippet: 'is_string(${1:x})', kind: 'function' },
  is_list: { sig: 'is_list(x)', doc: '是否向量。', snippet: 'is_list(${1:x})', kind: 'function' },
  version: { sig: 'version()', doc: 'OpenSCAD 版本向量。', snippet: 'version()', kind: 'function' },
  // ---------------- 特殊变量 ----------------
  $fn: {
    sig: '$fn = n',
    doc: '圆弧面数(片段数)。全局设置或在图元参数里单独给;`$fn = 64` 常用,导出打印件建议 ≥48,过大渲染慢。',
    snippet: '\\$fn = ${1:64};',
    kind: 'variable'
  },
  $fa: { sig: '$fa = deg', doc: '圆弧最小角步进(默认 12°);与 $fs 联合决定面数($fn 非 0 时优先)。', snippet: '\\$fa = ${1:6};', kind: 'variable' },
  $fs: { sig: '$fs = mm', doc: '圆弧最小边长(默认 2mm)。', snippet: '\\$fs = ${1:0.5};', kind: 'variable' },
  $t: { sig: '$t', doc: '动画时间 0~1(IDE 即时渲染不驱动动画,始终 0)。', snippet: '\\$t', kind: 'variable' },
  $preview: { sig: '$preview', doc: '预览模式为 true(IDE 内 WASM 走完整渲染,此值为 false)。', snippet: '\\$preview', kind: 'variable' },
  $children: { sig: '$children', doc: 'module 收到的子节点数量。', snippet: '\\$children', kind: 'variable' }
}

/** 关键字(高亮用;部分同时在 BUILTINS 里有文档) */
const KEYWORDS = ['module', 'function', 'if', 'else', 'for', 'intersection_for', 'let', 'each', 'include', 'use', 'true', 'false', 'undef']

let registered = false

/** 注册 OpenSCAD 语言(幂等;setupMonaco 内调用) */
export function registerOpenscadLanguage(): void {
  if (registered) return
  registered = true

  monaco.languages.register({ id: OPENSCAD_LANGUAGE_ID, extensions: ['.scad'] })

  monaco.languages.setLanguageConfiguration(OPENSCAD_LANGUAGE_ID, {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')']
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] }
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' }
    ],
    // include <file.scad> 的 <> 不做括号配对(会干扰小于号),交给 Monarch 着色
    wordPattern: /(\$?[A-Za-z_][A-Za-z0-9_]*)/
  })

  monaco.languages.setMonarchTokensProvider(OPENSCAD_LANGUAGE_ID, {
    defaultToken: '',
    keywords: KEYWORDS,
    builtins: Object.keys(BUILTINS).filter((k) => !k.startsWith('$') && !KEYWORDS.includes(k)),
    operators: ['=', '>', '<', '!', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '+', '-', '*', '/', '%', '^'],
    symbols: /[=><!?:&|+\-*/%^]+/,
    tokenizer: {
      root: [
        // include/use 的 <path>(整体按字符串着色)
        [/\b(include|use)(\s*)(<[^>]*>?)/, ['keyword', '', 'string']],
        // 特殊变量 $fn / $fa / ...
        [/\$[a-zA-Z_][\w]*/, 'variable.predefined'],
        // 标识符 / 关键字 / 内置
        // (调试修饰符前缀 * ! # % 不单独着色:与乘/取模/逻辑非操作符难以在
        //  Monarch 无语义信息下区分,统一按 operator 处理)
        [
          /[a-zA-Z_][\w]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@builtins': 'type.identifier',
              '@default': 'identifier'
            }
          }
        ],
        { include: '@whitespace' },
        [/[{}()[\]]/, '@brackets'],
        [/@symbols/, 'operator'],
        [/\d*\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/\d+([eE][-+]?\d+)?/, 'number'],
        [/[;,.]/, 'delimiter'],
        [/"([^"\\]|\\.)*$/, 'string.invalid'],
        [/"/, { token: 'string.quote', next: '@string' }]
      ],
      whitespace: [
        [/[ \t\r\n]+/, ''],
        [/\/\*/, 'comment', '@comment'],
        [/\/\/.*$/, 'comment']
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment']
      ],
      string: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, { token: 'string.quote', next: '@pop' }]
      ]
    }
  })

  // ---------------- 补全 ----------------
  monaco.languages.registerCompletionItemProvider(OPENSCAD_LANGUAGE_ID, {
    triggerCharacters: ['$'],
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      // $ 触发时把 $ 并入替换区间(wordPattern 含 $,getWordUntilPosition 已覆盖)
      const range = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn
      )
      const kindMap = {
        module: monaco.languages.CompletionItemKind.Method,
        function: monaco.languages.CompletionItemKind.Function,
        keyword: monaco.languages.CompletionItemKind.Keyword,
        variable: monaco.languages.CompletionItemKind.Variable
      } as const
      const suggestions: monaco.languages.CompletionItem[] = Object.entries(BUILTINS).map(
        ([name, b]) => ({
          label: { label: name, detail: '', description: b.sig },
          kind: kindMap[b.kind],
          detail: b.sig,
          documentation: { value: b.doc },
          insertText: b.snippet,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: (b.kind === 'variable' ? '2' : b.kind === 'function' ? '1' : '0') + name
        })
      )
      // 当前文件用户自定义 module/function 也纳入建议(轻量正则,无语义)
      const seen = new Set<string>()
      for (const m of model.getValue().matchAll(/\b(module|function)\s+([a-zA-Z_]\w*)\s*\(/g)) {
        const name = m[2]
        if (seen.has(name) || BUILTINS[name]) continue
        seen.add(name)
        suggestions.push({
          label: name,
          kind:
            m[1] === 'module'
              ? monaco.languages.CompletionItemKind.Class
              : monaco.languages.CompletionItemKind.Function,
          detail: `${m[1]} ${name}(...)(本文件)`,
          insertText: `${name}($1)`,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
          sortText: '0' + name
        })
      }
      return { suggestions }
    }
  })

  // ---------------- hover ----------------
  monaco.languages.registerHoverProvider(OPENSCAD_LANGUAGE_ID, {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position)
      if (!word) return null
      const b = BUILTINS[word.word]
      if (!b) return null
      return {
        range: new monaco.Range(
          position.lineNumber,
          word.startColumn,
          position.lineNumber,
          word.endColumn
        ),
        contents: [{ value: '```scad\n' + b.sig + '\n```' }, { value: b.doc }]
      }
    }
  })
}
