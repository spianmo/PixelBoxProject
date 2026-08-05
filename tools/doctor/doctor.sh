#!/usr/bin/env bash
# ============================================================
# PixelBox Doctor — 真机联调排错自检脚本 (macOS, zsh/bash 兼容)
#
# 用法:
#   ./tools/doctor/doctor.sh              # 全量体检 (环境/设备/固件/网络)
#   ./tools/doctor/doctor.sh --flash      # 体检通过后追加: idf.py flash
#   ./tools/doctor/doctor.sh --monitor    # 体检通过后追加: idf.py monitor
#   ./tools/doctor/doctor.sh --port /dev/cu.usbmodemXXX   # 指定串口
#
# 环境变量:
#   PIXELBOX_SERVER_URL   语音中继服务器地址 (默认 http://127.0.0.1:8787)
#   IDF_PATH              ESP-IDF 路径 (默认 ~/esp/esp-idf)
#
# 每项检查输出 [OK]/[WARN]/[FAIL] 与具体修复建议;
# 按症状排错见 docs/troubleshooting.md。
# ============================================================

# ---------- 定位仓库根目录 (脚本位于 tools/doctor/) ----------
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)

# ---------- 彩色输出 (非终端/NO_COLOR 时自动关闭) ----------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RED=$(printf '\033[31m');  C_GRN=$(printf '\033[32m')
    C_YLW=$(printf '\033[33m');  C_BLU=$(printf '\033[34m')
    C_BLD=$(printf '\033[1m');   C_RST=$(printf '\033[0m')
else
    C_RED=''; C_GRN=''; C_YLW=''; C_BLU=''; C_BLD=''; C_RST=''
fi

N_OK=0; N_WARN=0; N_FAIL=0

ok()   { N_OK=$((N_OK + 1));     printf '  %s[OK]%s   %s\n' "$C_GRN" "$C_RST" "$1"; }
warn() { N_WARN=$((N_WARN + 1)); printf '  %s[WARN]%s %s\n' "$C_YLW" "$C_RST" "$1"; }
fail() { N_FAIL=$((N_FAIL + 1)); printf '  %s[FAIL]%s %s\n' "$C_RED" "$C_RST" "$1"; }
# 修复建议 (缩进对齐, 可多次调用)
fix()  { printf '         %s→ %s%s\n' "$C_BLU" "$1" "$C_RST"; }
section() { printf '\n%s== %s ==%s\n' "$C_BLD" "$1" "$C_RST"; }

# ---------- 可移植超时执行 (macOS 无 timeout 命令) ----------
# px_timeout <秒> <命令...>  超时 kill; 返回命令退出码 (被杀时非 0)
px_timeout() {
    _to_sec="$1"; shift
    "$@" &
    _to_pid=$!
    ( sleep "$_to_sec"; kill -TERM "$_to_pid" 2>/dev/null
      sleep 1;          kill -KILL "$_to_pid" 2>/dev/null ) &
    _to_dog=$!
    wait "$_to_pid" 2>/dev/null
    _to_rc=$?
    kill -TERM "$_to_dog" 2>/dev/null
    wait "$_to_dog" 2>/dev/null
    return "$_to_rc"
}

# ---------- 参数解析 ----------
DO_FLASH=0; DO_MONITOR=0; PORT_OVERRIDE=''
while [ $# -gt 0 ]; do
    case "$1" in
        --flash)   DO_FLASH=1 ;;
        --monitor) DO_MONITOR=1 ;;
        --port)    shift; PORT_OVERRIDE="${1:-}" ;;
        -h|--help)
            sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) printf '未知参数: %s (支持 --flash / --monitor / --port <dev>)\n' "$1"; exit 2 ;;
    esac
    shift
done

printf '%sPixelBox Doctor%s — 真机联调自检 (%s)\n' "$C_BLD" "$C_RST" "$(date '+%Y-%m-%d %H:%M:%S')"
printf '仓库: %s\n' "$ROOT"

# ============================================================
# 1. 环境检查
# ============================================================
section "1/4 开发环境"

# --- ESP-IDF 安装与版本 (对齐基准: v5.5) ---
IDF_DIR="${IDF_PATH:-$HOME/esp/esp-idf}"
IDF_VER_H="$IDF_DIR/components/esp_common/include/esp_idf_version.h"
if [ -d "$IDF_DIR" ] && [ -f "$IDF_VER_H" ]; then
    IDF_MAJOR=$(sed -n 's/^#define ESP_IDF_VERSION_MAJOR[[:space:]]*\([0-9]*\).*/\1/p' "$IDF_VER_H")
    IDF_MINOR=$(sed -n 's/^#define ESP_IDF_VERSION_MINOR[[:space:]]*\([0-9]*\).*/\1/p' "$IDF_VER_H")
    if [ "$IDF_MAJOR" = "5" ] && [ "$IDF_MINOR" = "5" ]; then
        ok "ESP-IDF v${IDF_MAJOR}.${IDF_MINOR} 已安装 ($IDF_DIR)"
    else
        fail "ESP-IDF 版本为 v${IDF_MAJOR:-?}.${IDF_MINOR:-?}, 项目锁定 v5.5"
        fix "cd ~/esp/esp-idf && git fetch && git checkout v5.5 && git submodule update --init --recursive && ./install.sh esp32s3"
    fi
else
    fail "未找到 ESP-IDF ($IDF_DIR)"
    fix "安装: mkdir -p ~/esp && cd ~/esp && git clone -b v5.5 --recursive https://github.com/espressif/esp-idf.git"
    fix "国内镜像: git clone -b v5.5 --recursive https://jihulab.com/esp-mirror/espressif/esp-idf.git"
fi

# --- export.sh 是否已 source (决定 idf.py/esptool 可用) ---
IDF_ENV=0
if [ -n "${IDF_PATH:-}" ] && command -v idf.py >/dev/null 2>&1; then
    IDF_ENV=1
    ok "IDF 环境已激活 (idf.py 可用, IDF_PATH=$IDF_PATH)"
else
    warn "IDF 环境未激活 (本 shell 未 source export.sh)"
    fix "执行: source ~/esp/esp-idf/export.sh (建议加 alias get_idf 到 ~/.zshrc)"
    fix "注意: doctor.sh 是子进程, 需在你的交互 shell 里 source 后再运行才能生效"
fi

# --- python3 ---
if command -v python3 >/dev/null 2>&1; then
    ok "python3 $(python3 --version 2>&1 | sed 's/Python //')"
else
    fail "缺少 python3"
    fix "brew install python3"
fi

# --- esptool (随 IDF python 环境提供) ---
ESPTOOL=''
if command -v esptool.py >/dev/null 2>&1; then
    ESPTOOL='esptool.py'
elif command -v esptool >/dev/null 2>&1; then
    ESPTOOL='esptool'
fi
if [ -n "$ESPTOOL" ]; then
    ok "esptool 可用 ($ESPTOOL)"
else
    if [ "$IDF_ENV" = "1" ]; then
        fail "IDF 环境已激活但找不到 esptool"
        fix "重装 IDF 工具链: cd ~/esp/esp-idf && ./install.sh esp32s3"
    else
        warn "esptool 不可用 (随 export.sh 提供, 激活 IDF 环境后重试)"
        fix "source ~/esp/esp-idf/export.sh"
    fi
fi

# --- node >= 20 ---
if command -v node >/dev/null 2>&1; then
    NODE_V=$(node -v 2>/dev/null)           # 形如 v22.1.0
    NODE_MAJOR=$(printf '%s' "$NODE_V" | sed 's/^v//' | cut -d. -f1)
    case "$NODE_MAJOR" in
        ''|*[!0-9]*) warn "node 版本无法解析: $NODE_V" ;;
        *)
            if [ "$NODE_MAJOR" -ge 20 ]; then
                ok "node $NODE_V (>= 20)"
            else
                fail "node $NODE_V 过旧, SDK/server/simulator 需要 node >= 20"
                fix "升级: brew install node@22 或使用 nvm install 22"
            fi ;;
    esac
else
    fail "缺少 node (SDK CLI / server / simulator 依赖)"
    fix "brew install node@22"
fi

# --- npm ---
if command -v npm >/dev/null 2>&1; then
    ok "npm $(npm -v 2>/dev/null)"
else
    fail "缺少 npm"
    fix "npm 随 node 安装, 先解决上一项"
fi

# --- SDK 是否已构建 (pixelbox CLI 入口) ---
if [ -f "$ROOT/sdk/dist/cli.js" ]; then
    ok "SDK 已构建 (sdk/dist/cli.js 存在)"
else
    warn "SDK 未构建, pixelbox CLI 不可用"
    fix "cd $ROOT/sdk && npm install && npm run build"
fi

# ============================================================
# 2. 设备检查 (macOS 串口扫描 + esptool 探测)
# ============================================================
section "2/4 USB 设备"

# 三类 macOS 串口:
#   cu.usbmodem*      ESP32-S3 原生 USB (USB-Serial-JTAG, 板载 USB-C 直连)
#   cu.wchusbserial*  沁恒 CH340/CH343 外置串口芯片
#   cu.SLAB*          Silicon Labs CP210x 外置串口芯片
DEVICES=$(find /dev -maxdepth 1 \
    \( -name 'cu.usbmodem*' -o -name 'cu.wchusbserial*' -o -name 'cu.SLAB*' \) \
    2>/dev/null | sort)

FIRST_PORT=''
if [ -n "$DEVICES" ]; then
    while IFS= read -r dev; do
        [ -n "$dev" ] || continue
        case "$dev" in
            /dev/cu.usbmodem*)      kind='USB-Serial-JTAG (S3 原生 USB, 微雪板 USB-C 即此类)' ;;
            /dev/cu.wchusbserial*)  kind='CH340/CH343 外置串口芯片' ;;
            /dev/cu.SLAB*)          kind='CP210x 外置串口芯片' ;;
            *)                      kind='未知类型' ;;
        esac
        ok "发现串口: $dev — $kind"
        [ -n "$FIRST_PORT" ] || FIRST_PORT="$dev"
    done <<EOF
$DEVICES
EOF

    PORT="${PORT_OVERRIDE:-$FIRST_PORT}"

    # esptool 探测芯片与 flash 大小 (flash_id 同时输出两者), 15s 超时
    if [ -n "$ESPTOOL" ]; then
        printf '  探测 %s (esptool flash_id, 15s 超时)...\n' "$PORT"
        PROBE_OUT=$(px_timeout 15 "$ESPTOOL" --port "$PORT" flash_id 2>&1)
        PROBE_RC=$?
        CHIP=$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^Chip is \(.*\)/\1/p' | head -1)
        FSIZE=$(printf '%s\n' "$PROBE_OUT" | sed -n 's/^Detected flash size: \(.*\)/\1/p' | head -1)
        if [ "$PROBE_RC" -eq 0 ] && [ -n "$CHIP" ]; then
            ok "芯片: $CHIP / flash: ${FSIZE:-未知} (期望 ESP32-S3 + 16MB)"
        else
            fail "esptool 探测失败/超时 (设备可能未进下载模式或被 monitor 等进程占用)"
            fix "进下载模式: 按住 BOOT 键不放 → 插 USB 线 (或按一下 RESET) → 松开 BOOT, 再重试"
            fix "确认没有其他程序占用串口 (idf.py monitor / 串口调试器), 关闭后重试"
            fix "换一根确认可传数据的 USB-C 线 (纯充电线枚举不出串口或时断时续)"
        fi
    else
        warn "esptool 不可用, 跳过芯片探测 (先 source ~/esp/esp-idf/export.sh)"
    fi
else
    PORT=''
    warn "未检测到设备 (扫描 /dev/cu.usbmodem* /dev/cu.wchusbserial* /dev/cu.SLAB*)"
    fix "最常见: USB-C 线是纯充电线, 换一根带数据的线 (烧录必须数据线)"
    fix "线插在板子的 USB-C 口上了吗? 微雪 AMOLED-1.8 的 USB-C 即 S3 原生 USB, 无需驱动"
    fix "若用外置串口板 (CH340/CP210x): macOS 需安装对应厂商驱动后重新插拔"
    fix "插拔后重跑本脚本; 仍无则换电脑 USB 口 (避开无供电的 HUB)"
fi

# ============================================================
# 3. 固件检查
# ============================================================
section "3/4 固件构建产物"

FW_BIN="$ROOT/firmware/build/pixelbox.bin"
if [ -f "$FW_BIN" ]; then
    ok "固件已构建: firmware/build/pixelbox.bin ($(du -h "$FW_BIN" | cut -f1 | tr -d ' '))"
    # 新鲜度: 任一源码文件比 bin 新则提示重编 (排除 build/managed_components)
    STALE=$(find "$ROOT/firmware" \
        \( -path "$ROOT/firmware/build" -o -path "$ROOT/firmware/managed_components" \) -prune \
        -o -type f \( -name '*.c' -o -name '*.cpp' -o -name '*.h' -o -name '*.hpp' \
                      -o -name 'CMakeLists.txt' -o -name 'Kconfig*' -o -name '*.csv' \
                      -o -name 'sdkconfig.defaults' -o -name '*.js' \) \
        -newer "$FW_BIN" -print 2>/dev/null | head -3)
    if [ -n "$STALE" ]; then
        warn "源码比构建产物新, 烧录前建议重编"
        printf '%s\n' "$STALE" | while IFS= read -r f; do
            fix "变更: ${f#"$ROOT"/}"
        done
        fix "重编: cd $ROOT/firmware && idf.py build"
    else
        ok "构建产物新鲜 (无源码晚于 pixelbox.bin)"
    fi
else
    warn "固件未构建 (firmware/build/pixelbox.bin 不存在)"
    fix "首次构建: source ~/esp/esp-idf/export.sh && cd $ROOT/firmware && idf.py set-target esp32s3 && idf.py build"
    fix "官方组件源不稳时: export IDF_COMPONENT_STORAGE_URL=https://components-file.espressif.cn"
fi

# ============================================================
# 4. 网络检查 (mDNS 设备发现 + 语音中继 server)
# ============================================================
section "4/4 网络服务"

# --- mDNS 浏览 _pixelbox._tcp (dns-sd 常驻, 3s 超时截取) ---
if command -v dns-sd >/dev/null 2>&1; then
    printf '  浏览 mDNS _pixelbox._tcp (3s)...\n'
    MDNS_OUT=$(px_timeout 3 dns-sd -B _pixelbox._tcp local. 2>/dev/null)
    MDNS_LIST=$(printf '%s\n' "$MDNS_OUT" | awk '/Add/ && /_pixelbox._tcp/ { name=""; for (i=7; i<=NF; i++) name = name (name=="" ? "" : " ") $i; print name }' | sort -u)
    if [ -n "$MDNS_LIST" ]; then
        MDNS_N=$(printf '%s\n' "$MDNS_LIST" | grep -c .)
        ok "发现 $MDNS_N 台在线 PixelBox:"
        printf '%s\n' "$MDNS_LIST" | while IFS= read -r n; do
            printf '         · %s\n' "$n"
        done
        fix "推送/看日志: pixelbox push --device <名称|ip> / pixelbox logs"
    else
        warn "局域网内未发现 _pixelbox._tcp 设备"
        fix "设备要先连上 Wi-Fi (看串口日志确认拿到 IP); 首次配网见 docs/getting-started.md 第 3 步"
        fix "电脑与设备须同一网段; 路由器关闭 AP 隔离/访客网络"
        fix "绕过发现直接推: pixelbox push --device <设备IP>"
    fi
else
    warn "缺少 dns-sd 命令 (macOS 自带, 异常环境), 跳过 mDNS 检查"
fi

# --- 语音中继 server /healthz (默认 8787, 可 env 覆盖) ---
SERVER_URL="${PIXELBOX_SERVER_URL:-http://127.0.0.1:8787}"
if command -v curl >/dev/null 2>&1; then
    if HZ=$(curl -fsS --max-time 3 "$SERVER_URL/healthz" 2>/dev/null); then
        ok "语音中继在线: $SERVER_URL/healthz → $HZ"
    else
        warn "语音中继未响应 ($SERVER_URL/healthz) — 不用语音功能可忽略"
        fix "启动: cd $ROOT/server && npm install && cp .env.example .env (填 key) && npm run build && npm start"
        fix "非默认地址: PIXELBOX_SERVER_URL=http://<ip>:<port> ./tools/doctor/doctor.sh"
    fi
else
    warn "缺少 curl, 跳过 server 探测"
fi

# ============================================================
# 汇总
# ============================================================
printf '\n%s体检汇总:%s %s%d OK%s / %s%d WARN%s / %s%d FAIL%s\n' \
    "$C_BLD" "$C_RST" "$C_GRN" "$N_OK" "$C_RST" "$C_YLW" "$N_WARN" "$C_RST" "$C_RED" "$N_FAIL" "$C_RST"
printf '按症状排错手册: docs/troubleshooting.md (烧录/黑屏/无声/发现不了设备/语音链路...)\n'

# ============================================================
# 可选动作: --flash / --monitor (需 IDF 环境 + 设备)
# ============================================================
if [ "$DO_FLASH" = "1" ] || [ "$DO_MONITOR" = "1" ]; then
    section "可选动作"
    if [ "$IDF_ENV" != "1" ]; then
        fail "需要先激活 IDF 环境: source ~/esp/esp-idf/export.sh"
        exit 1
    fi
    if [ -z "$PORT" ]; then
        fail "未检测到设备串口, 无法执行 flash/monitor (--port 可手动指定)"
        exit 1
    fi
    if [ "$DO_FLASH" = "1" ]; then
        if [ ! -f "$FW_BIN" ]; then
            fail "固件未构建, 先: cd $ROOT/firmware && idf.py build"
            exit 1
        fi
        printf '  执行: idf.py -p %s flash\n' "$PORT"
        ( cd "$ROOT/firmware" && idf.py -p "$PORT" flash ) || {
            fail "烧录失败, 排查见 docs/troubleshooting.md「烧录失败」"
            exit 1
        }
        ok "烧录完成"
    fi
    if [ "$DO_MONITOR" = "1" ]; then
        printf '  执行: idf.py -p %s monitor  %s(退出请按 Ctrl+], Windows 另有 Ctrl+T Ctrl+X)%s\n' \
            "$PORT" "$C_YLW" "$C_RST"
        ( cd "$ROOT/firmware" && idf.py -p "$PORT" monitor )
    fi
fi

[ "$N_FAIL" -eq 0 ]
