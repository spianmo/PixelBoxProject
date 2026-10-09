#!/usr/bin/env python3
"""PixelBox NuttX 原生构建入口；不加载 ESP-IDF，不修改用户的 NuttX 源码树。"""
from __future__ import annotations

import argparse
import glob
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
from contextlib import contextmanager

ROOT = Path(__file__).resolve().parents[1]
PROFILES = {"esp32s3": "esp32s3-devkit:nsh", "esp32s3-multinet7": "esp32s3-devkit:nsh",
            "esp32s3-timed-sleep": "esp32s3-devkit:nsh"}
PROFILE_BASES = {"esp32s3-multinet7": "esp32s3", "esp32s3-timed-sleep": "esp32s3"}
TASKS = ("configure", "build", "flash", "merge", "clean")
STATE_FILE = ".pixelbox-build.json"
OFFLINE_DEPS_FILE = ".offline-deps.json"
FLASH_IMAGE_OFFSET = 0x0
FLASH_STORAGE_OFFSET = 0x800000
FLASH_STORAGE_SIZE = 0x800000
FLASH_SECTOR_SIZE = 0x1000
# 仅用于本工程验证过的 Waveshare ESP32-S3-Touch-AMOLED-2.16 / WROOM-1-N16R8。
# 2026-10-02 从该板 ROM 读取 0x3ff1fffc -> 0x3ff1ae90，再读取 layout 的
# dram0_rtos_reserved_start 得到此端点；它不是链接脚本 DRAM 终点，也不代表其它芯片。
INTERNAL_HEAP_ROM_START = 0x3FCEEE34
INTERNAL_HEAP_MINIMUM_TAIL = 4096
INTERNAL_HEAP_ROM_SOURCE = ("Waveshare ESP32-S3-Touch-AMOLED-2.16 / ESP32-S3-WROOM-1-N16R8; "
                            "2026-10-02 ROM layout@0x3ff1fffc -> 0x3ff1ae90; "
                            "dram0_rtos_reserved_start=0x3fceee34")
LITTLEFS_VERSION = "v2.5.1"
LITTLEFS_ROOT = "littlefs-2.5.1"
LITTLEFS_SHA256 = "77acdd699fbc8c62efe1467a90de4bde133517fb370b10a538e25d341a11b4e1"
# 无线二进制必须与 NuttX HAL 锁定的 IDF 5.1.4 头文件精确匹配；版本号相同仍可能 ABI 不同。
ESP_HAL_DEPENDENCY_ROOT = "esp-hal-idf5.1.4"
ESP_HAL_HEADER_SHA256 = {
    "components/esp_wifi/include/esp_wifi.h": "ec6da5a4c97665ca274564e783f4a658741313de6b4c32d53ddab529aa10512e",
    "components/esp_wifi/include/esp_private/wifi_os_adapter.h": "5ce888a8d031d97446eb643c5bb77346453a30726c22060196784ed662671181",
    "components/esp_wifi/include/esp_wifi_types.h": "93d316d8cf39afe6ec4748f1aa0760c66e04955766d267cd4a771306283107c0",
}
ESP_HAL_LIBRARY_SHA256 = {
    "components/esp_wifi/lib/esp32s3/libcore.a": "54c1c6268400a9732fb56ee6840a59b5679cb4d0645ec816d8ee0088ddb89ebb",
    "components/esp_wifi/lib/esp32s3/libespnow.a": "c68ea77b21fd95a2e993f38abbaa8c564f0cd1751dba76dbdaa61803d048059d",
    "components/esp_wifi/lib/esp32s3/libmesh.a": "97ec477beb2039a8b084acd05967160fbebcfa88b6970ec262e1f071f2e6bcf0",
    "components/esp_wifi/lib/esp32s3/libnet80211.a": "7eaf5419559a15b9f00a2f67ce0fefa40ffbbd10157307224d4b88c16c4683f3",
    "components/esp_wifi/lib/esp32s3/libpp.a": "fa29acff90f4c85ee2f8fc077a491340cb70c481a899150d1445ffae0f7246af",
    "components/esp_wifi/lib/esp32s3/libsmartconfig.a": "0a04c23f67c7503a7459fe1142857236919b69423cc366f47e824c1356ecce07",
    "components/esp_wifi/lib/esp32s3/libwapi.a": "acc4403f0fdf9dbb44e634eee4297b200ea3bf3d6cd1737c1a9c63438840c4d6",
    "components/esp_phy/lib/esp32s3/libbtbb.a": "62749de05c432584f207f3c3b660617620eb35cca9bbe4716f90175fb09ac029",
    "components/esp_phy/lib/esp32s3/libbttestmode.a": "14495d9ed96eabe3862fa53163b1d2f993cbf35636ce02839eca177558cfef67",
    "components/esp_phy/lib/esp32s3/libphy.a": "95560823fa3e3cc08858327fabf7146a10914485ff2e5ff2046de852241f9581",
    "components/esp_phy/lib/esp32s3/librfate.a": "b451caa66762e21b1516865fee89105027085ecdb95484ad61e9b649b56ddc6f",
    "components/esp_phy/lib/esp32s3/librftest.a": "c54d142239363adef6d7675b2ce7f7592696ed69c92f89e1628d119bfc0becad",
    "components/esp_coex/lib/esp32s3/libcoexist.a": "687141768f79b19d18069306255ff14fdb785a03c5effa37a6d801adcf5ae580",
    "components/bt/controller/lib_esp32c3_family/esp32s3/libbtdm_app.a": "4bc1646906e90da898096c09df05dd16fc03158feacbce2c1dbae2e39ce8e79c"
}
ESP_HAL_REPO_RELATIVE = Path("arch/xtensa/src/esp32s3/esp-hal-3rdparty")
ESP_HAL_OFFLINE_MARKER = ".nuttx-offline-hal-ready"
TOOLCHAIN_ENV_VARS = ("NUTTX_TOOLCHAIN_PATH", "ESP32S3_TOOLCHAIN_PATH",
                      "XTENSA_TOOLCHAIN_PATH")


def _candidate_bin_dirs() -> list[Path]:
    """返回独立 NuttX 工具可能所在的 bin 目录，不读取 ESP-IDF 环境。"""
    candidates: list[Path] = []
    for name in TOOLCHAIN_ENV_VARS:
        value = os.environ.get(name)
        if value:
            path = Path(value).expanduser()
            candidates.append(path.parent if path.is_file() else
                              (path / "bin" if (path / "bin").is_dir() else path))
    home = Path.home()
    patterns = (
        home / ".espressif/tools/xtensa-esp32s3-elf/*/xtensa-esp32s3-elf/bin",
        home / ".espressif/tools/xtensa-esp-elf/*/xtensa-esp-elf/bin",
    )
    for pattern in patterns:
        # Path.glob 不接受绝对模式；使用 glob 模块扫描用户目录中的版本目录。
        candidates.extend(Path(path) for path in sorted(glob.glob(str(pattern)))
                          if Path(path).is_dir())
    candidates.extend(Path(path) for path in ("/opt/homebrew/bin", "/usr/local/bin")
                      if Path(path).is_dir())
    # 保持顺序但去重，避免环境变量与自动扫描重复探测。
    return list(dict.fromkeys(candidates))


def discover_toolchain() -> tuple[Path, str] | None:
    """发现 Xtensa 工具链，兼容旧命名和 Espressif 新版命名。"""
    names = ("xtensa-esp32s3-elf-gcc", "xtensa-esp-elf-gcc")
    for directory in _candidate_bin_dirs():
        for name in names:
            if (directory / name).is_file() and os.access(directory / name, os.X_OK):
                return directory, name
    for name in names:
        located = shutil.which(name)
        if located:
            return Path(located).resolve().parent, name
    return None


def discover_kconfig_tools(extra_dirs: list[Path] | None = None) -> tuple[Path, str, str] | None:
    """发现 kconfig-frontends 的 kconfig-conf 与 kconfig-tweak。"""
    candidates = list(extra_dirs or [])
    configured = os.environ.get("KCONFIG_FRONTENDS_PATH")
    if configured:
        path = Path(configured).expanduser()
        candidates.append(path / "bin" if (path / "bin").is_dir() else path)
    # IDE 启动的子进程不会继承开发者 shell 中手动设置的变量；优先使用
    # 仓库物化的依赖目录，保证 CLI 与 IDE 走同一套工具发现逻辑。
    candidates.append(ROOT.parent / ".deps" / "kconfig-bin")
    candidates.extend(Path(path) for path in ("/opt/homebrew/bin", "/usr/local/bin")
                      if Path(path).is_dir())
    candidates.append(None)
    for directory in candidates:
        locate = (lambda name: directory / name if directory else
                  (Path(shutil.which(name)) if shutil.which(name) else None))
        conf = locate("kconfig-conf")
        tweak = locate("kconfig-tweak")
        if conf and tweak and conf.is_file() and tweak.is_file():
            return (conf.parent, str(conf), str(tweak))
    return None


def discover_kconfiglib() -> Path | None:
    """查找 NuttX Make 可识别的 kconfiglib 命令目录。"""
    candidates: list[Path] = []
    configured = os.environ.get("KCONFIGLIB_PATH")
    if configured:
        path = Path(configured).expanduser()
        candidates.append(path / "bin" if (path / "bin").is_dir() else path)
    # 项目本地虚拟环境用于 macOS/Linux 的可复现构建，不依赖全局 pip。
    candidates.append(ROOT.parent / ".deps" / "kconfig-venv" / "bin")
    for directory in candidates:
        if (directory / "menuconfig").is_file() and (directory / "olddefconfig").is_file():
            return directory.resolve()
    if shutil.which("menuconfig") and shutil.which("olddefconfig"):
        return Path(shutil.which("menuconfig")).resolve().parent
    return None


def discover_esptool() -> Path | None:
    """查找 NuttX Make 所需的 esptool.py，不调用 ESP-IDF。"""
    local_venv = ROOT.parent / ".deps" / "nuttx-venv" / "bin"
    for name in ("esptool.py", "esptool"):
        candidate = local_venv / name
        if candidate.is_file():
            return candidate.resolve()
    configured = os.environ.get("ESPTOOL_PATH")
    if configured:
        path = Path(configured).expanduser()
        if path.is_dir():
            path = path / "esptool.py"
        if path.is_file():
            return path.resolve()
    for name in ("esptool.py", "esptool"):
        located = shutil.which(name)
        if located:
            return Path(located).resolve()
    return None


def prepend_path(env: dict[str, str], directories: list[Path | None]) -> None:
    """把项目兼容工具和外部独立工具放在子进程 PATH 最前面。"""
    values = [str(path) for path in directories if path and path.is_dir()]
    current = env.get("PATH", os.defpath).split(os.pathsep)
    env["PATH"] = os.pathsep.join(list(dict.fromkeys(values + current)))


@contextmanager
def project_lock(root: Path):
    # 操作系统持锁，取消进程后自动释放；CLI 与 IDE 也不能同时改同一个构建树。
    import fcntl
    lock_path = root / ".nuttx-build.lock"
    with lock_path.open("a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise ValueError("此固件工程已有 NuttX 构建任务正在运行") from error
        try:
            yield
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def run(args: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    # 参数始终通过 argv 传递，不让项目路径或串口名称进入 shell 解释。
    print("[nuttx] " + " ".join(args), flush=True)
    subprocess.run(args, cwd=cwd, env=env, check=True)


def parse_config(text: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        match = re.fullmatch(r"(CONFIG_[A-Z0-9_]+)=(.*)", line.strip())
        disabled = re.fullmatch(r"# (CONFIG_[A-Z0-9_]+) is not set", line.strip())
        if match:
            result[match[1]] = match[2]
        elif disabled:
            result[disabled[1]] = "n"
    return result


def apply_overlay(config: Path, overlay: Path) -> None:
    replacements = parse_config(overlay.read_text(encoding="utf-8"))
    lines = []
    for line in config.read_text(encoding="utf-8").splitlines():
        key = next(iter(parse_config(line)), None)
        if key not in replacements:
            lines.append(line)
    for key, value in replacements.items():
        lines.append(f"# {key} is not set" if value == "n" else f"{key}={value}")
    config.write_text("\n".join(lines) + "\n", encoding="utf-8")


def validate_config(config: Path, *, portal_requested: bool = False,
                    multinet_requested: bool = False, sleep_requested: bool = False) -> dict[str, str]:
    values = parse_config(config.read_text(encoding="utf-8"))
    required = {
        "CONFIG_INTERPRETERS_PIXELBOX": "y",
        "CONFIG_ESPRESSIF_SIMPLE_BOOT": "y",
        "CONFIG_BUILD_FLAT": "y",
        "CONFIG_INIT_ENTRYPOINT": '"pixelbox_boot_main"',
        "CONFIG_ESP32S3_FLASH_16M": "y",
    }
    for key, value in required.items():
        if values.get(key) != value:
            raise ValueError(f"配置不满足 {key}={value}，请检查 NuttX 版本及 profile")
    # 此板型后 8 MiB 永久保留应用数据，不能相信任意修改后的配置来扩大烧录范围。
    for key, expected in (("CONFIG_ESP32S3_STORAGE_MTD_OFFSET", FLASH_STORAGE_OFFSET),
                          ("CONFIG_ESP32S3_STORAGE_MTD_SIZE", FLASH_STORAGE_SIZE)):
        try:
            actual = int(values.get(key, ""), 0)
        except ValueError:
            actual = None
        if actual != expected:
            raise ValueError(f"固定存储区布局需要 {key}={expected:#x}，拒绝覆盖应用数据")
    for key in ("CONFIG_ESPRESSIF_MERGE_BINS", "CONFIG_ESP32S3_MERGE_BINS",
                "CONFIG_ESP32S3_QEMU_IMAGE"):
        if values.get(key) == "y":
            raise ValueError(f"不能启用 {key}：只允许 offset 0 的 Simple Boot 单镜像，禁止整片填充/合并")
    if values.get("CONFIG_ESPRESSIF_WIFI") == "y" and values.get("CONFIG_PTHREAD_MUTEX_TYPES") != "y":
        raise ValueError("Wi-Fi 需要 CONFIG_PTHREAD_MUTEX_TYPES=y 创建递归互斥锁")
    sleep_enabled = values.get("CONFIG_INTERPRETERS_PIXELBOX_TIMED_SLEEP") == "y"
    if sleep_requested and not sleep_enabled:
        raise ValueError("请求的 CONFIG_INTERPRETERS_PIXELBOX_TIMED_SLEEP=y 未生效")
    if sleep_enabled:
        for key, expected in (("CONFIG_PM", "y"), ("CONFIG_ARCH_CHIP_ESP32S3", "y"),
                              ("CONFIG_PM_GOVERNOR_EXPLICIT_RELAX", "-1")):
            if values.get(key) != expected:
                raise ValueError(f"显式定时深睡需要 {key}={expected}，拒绝自动空闲休眠")
    # Kconfig 不表达数值 ABI 等式；显式请求也不能被 olddefconfig 静默关闭。
    multinet_enabled = values.get("CONFIG_INTERPRETERS_PIXELBOX_MULTINET7") == "y"
    if multinet_requested and not multinet_enabled:
        raise ValueError("请求的 CONFIG_INTERPRETERS_PIXELBOX_MULTINET7=y 未生效，请检查模型依赖")
    if multinet_enabled:
        for key in ("CONFIG_ARCH_CHIP_ESP32S3", "CONFIG_ESP32S3_SPIRAM",
                    "CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP", "CONFIG_ARCH_SETJMP_H"):
            if values.get(key) != "y":
                raise ValueError(f"MultiNet7 ABI 需要 {key}=y")
        try:
            cp_initset = int(values.get("CONFIG_XTENSA_CP_INITSET", ""), 0)
        except ValueError:
            cp_initset = None
        if cp_initset != 0x0009:
            raise ValueError("MultiNet7 ABI 需要 CONFIG_XTENSA_CP_INITSET=0x0009（CP0 + CP3）")
    # olddefconfig 会静默关闭缺少依赖的门户，显式请求必须在最终配置中兑现。
    portal_enabled = values.get("CONFIG_INTERPRETERS_PIXELBOX_PORTAL") == "y"
    if portal_requested and not portal_enabled:
        raise ValueError("请求的 CONFIG_INTERPRETERS_PIXELBOX_PORTAL=y 未生效，请检查门户依赖")
    if portal_enabled:
        for key in ("CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP", "CONFIG_NETDEV_WIRELESS_IOCTL",
                    "CONFIG_NETUTILS_DHCPD", "CONFIG_NET_BINDTODEVICE"):
            if values.get(key) != "y":
                raise ValueError(f"Wi-Fi 门户需要 {key}=y")
        # HTTP/AP 固定使用 192.168.4.1；不能向手机发放另一网段或不存在的 DNS。
        for key, expected in (("CONFIG_NETUTILS_DHCPD_STARTIP", 0xc0a80402),
                              ("CONFIG_NETUTILS_DHCPD_NETMASK", 0xffffff00),
                              ("CONFIG_NETUTILS_DHCPD_ROUTERIP", 0xc0a80401),
                              ("CONFIG_NETUTILS_DHCPD_DNSIP", 0),
                              ("CONFIG_NETUTILS_DHCPD_MAXLEASES", 4)):
            try:
                actual = int(values.get(key, ""), 0)
            except ValueError:
                actual = None
            if actual != expected:
                raise ValueError(f"Wi-Fi 门户固定地址池需要 {key}={expected:#x}")
    if values.get("CONFIG_NIMBLE") == "y":
        # Kconfig 会静默丢弃缺少父选项的子项；必须检查最终配置，而非只检查 overlay。
        for key in ("CONFIG_ALLOW_BSD_COMPONENTS", "CONFIG_WIRELESS",
                    "CONFIG_WIRELESS_BLUETOOTH", "CONFIG_NET_BLUETOOTH",
                    "CONFIG_DRIVERS_BLUETOOTH", "CONFIG_ESPRESSIF_BLE",
                    "CONFIG_NETDEV_IFINDEX", "CONFIG_NETDEV_IOCTL"):
            if values.get(key) != "y":
                raise ValueError(f"NimBLE RAW HCI 传输需要 {key}=y")
        if values.get("CONFIG_WIRELESS_BLUETOOTH_HOST") == "y":
            raise ValueError("NimBLE 需要 CONFIG_WIRELESS_BLUETOOTH_HOST=n，不能同时启用两个 host")
    if values.get("CONFIG_NET_TCP") == "y":
        # devd 与 JS 网络采用 poll + 非阻塞 I/O；缺少 backlog 会在 accept 前重置连接，
        # 无发送缓冲的 NuttX send 会等待 ACK，阻塞整个 VM 的事件循环。
        for key in ("CONFIG_NET_TCPBACKLOG", "CONFIG_NET_TCP_WRITE_BUFFERS"):
            if values.get(key) != "y":
                raise ValueError(f"非阻塞网络事件循环需要 {key}=y")
    for key in ("CONFIG_ESP32S3_APP_FORMAT_LEGACY", "CONFIG_ESP32S3_APP_FORMAT_MCUBOOT"):
        if values.get(key) == "y":
            raise ValueError(f"此工程只支持无 ESP-IDF 的 Simple Boot，不能启用 {key}")
    return values


def find_apps(nuttx: Path, override: str | None) -> Path:
    choices = [Path(override).expanduser()] if override else [
        nuttx.parent / "apps", nuttx.parent / "nuttx-apps",
        nuttx.parent / nuttx.name.replace("nuttx-", "nuttx-apps-", 1),
    ]
    for path in choices:
        if (path / "Application.mk").is_file() and (path / "interpreters/Make.defs").is_file():
            return path.resolve()
    raise ValueError("找不到 nuttx-apps，请放在 NuttX 同级 apps/，或传 --apps-path")


def ignored(directory: str, names: list[str]) -> set[str]:
    # 构建只使用源码；不继承上游检出的缓存、配置和旧镜像。
    exact = {".git", ".config", ".config.old", ".config.orig", ".kconfig.preconfig",
             ".version.old", "build", "build-host", "staging", "nuttx.bin",
             "nuttx.hex", "nuttx.map", "libapps.a", ".cache", "__pycache__",
             ".dirlinks", ".depend", ".built", ".context", "Make.dep"}
    return {name for name in names if name in exact or name.endswith((".o", ".a", ".d"))
            or (name == "nuttx" and (Path(directory) / name).is_file())}


def copy_sources(nuttx: Path, apps: Path, tree: Path, app_tree: Path,
                 require_esp_hal: bool = False) -> None:
    roots = ((nuttx, tree), (apps, app_tree))
    # 仅在没有 .sources-ready 时调用。丢弃未完成快照后重复制，避免遗留已删源码或旧链接；
    # rmtree 不跟随目录内的符号链接，源 SDK 和链接目标不会被清理。
    for _, destination in roots:
        if destination.is_symlink():
            destination.unlink()
        elif destination.exists():
            shutil.rmtree(destination)

    def copy_tree(source: Path, destination: Path, source_root: Path) -> None:
        # 重试时不跟随旧的目录链接，避免把复制操作写回 SDK 或构建树外。
        if destination.is_symlink():
            destination.unlink()
        destination.mkdir(parents=True, exist_ok=True)
        entries = sorted(source.iterdir())
        excluded = ignored(str(source), [entry.name for entry in entries])
        for entry in entries:
            if entry.name in excluded:
                continue
            relative = entry.relative_to(source_root)
            # 这些目录由 NuttX 的 sethost/configure 阶段创建为链接或生成源码。
            # 上游仓库用 .gitignore 排除它们，但工作区可能保留普通目录（例如
            # esp-hal-3rdparty 子模块），复制进去会让 clean_dirlinks 误判并中止配置。
            if source_root == nuttx and (
                relative.as_posix() in ("include/arch", "drivers/platform")
                or (len(relative.parts) == 4 and relative.parts[0] == "arch"
                    and relative.parts[2] == "src"
                    and relative.parts[3] in ("chip", "board"))
            ):
                continue
            output = destination / entry.name
            if source_root == nuttx and relative.as_posix() in ("arch/dummy/Kconfig", "boards/dummy/Kconfig"):
                continue
            if entry.is_symlink():
                # 已配置 SDK 的板级链接由当前 profile 重新生成，不能继承旧板型。
                if source_root == nuttx and (relative.as_posix() in ("Make.defs", "include/arch", "drivers/platform")
                        or any(relative.match(pattern) for pattern in (
                            "arch/*/src/chip", "arch/*/src/board", "arch/*/include/chip",
                            "arch/*/include/board", "boards/*/*/*/src/board"))):
                    continue
                try:
                    target = entry.resolve(strict=True)
                except FileNotFoundError:
                    # 允许指向树内待生成文件，但仍按最终目录位置重定位。
                    target = entry.resolve()
                except (RuntimeError, OSError) as error:
                    raise ValueError(f"源码符号链接无法解析（循环或不可访问）: {entry}") from error
                mapped = next((build_root / target.relative_to(sdk_root)
                               for sdk_root, build_root in roots
                               if target == sdk_root or sdk_root in target.parents), None)
                link = Path(os.readlink(entry))
                if mapped is None and source_root == nuttx and not link.is_absolute():
                    # 官方 fs/zipfs/zlib 使用兄弟 apps/，发布包的实际 apps 目录名可带版本号。
                    # 仅认这个相对目录别名；先归一化 ..，不允许借别名跳出所选 apps 快照。
                    standard_apps = nuttx.parent / "apps"
                    lexical_target = Path(os.path.abspath(entry.parent / link))
                    if lexical_target == standard_apps or standard_apps in lexical_target.parents:
                        mapped = app_tree / lexical_target.relative_to(standard_apps)
                if mapped is None:
                    raise ValueError(f"符号链接指向 NuttX/apps 源码树外，无法安全隔离: {entry}")
                if output.is_symlink():
                    output.unlink()
                elif output.exists():
                    raise ValueError(f"源码类型已改变，请先 clean: {output}")
                # 使用构建树内相对链接；目录移动后也不会重新指向原 SDK。
                output.symlink_to(os.path.relpath(mapped, output.parent))
            elif entry.is_dir():
                copy_tree(entry, output, source_root)
            else:
                if output.is_symlink():
                    output.unlink()
                # 部分写入的普通文件直接覆盖；只有全部复制成功才写 .sources-ready。
                shutil.copy2(entry, output)

    for source, destination in roots:
        copy_tree(source, destination, source)

    # NuttX 的 ESP32S3 hal.mk 通过 arch/xtensa/src/chip 访问这个目录。
    # chip 本身由 configure 生成到 esp32s3；复制 HAL 到链接目标目录，避免
    # 把源码树里的 chip 目录或绝对路径链接带入工程快照，也不触发在线 clone。
    hal_source = nuttx / "arch" / "xtensa" / "src" / "chip" / "esp-hal-3rdparty"
    hal_destination = tree / "arch" / "xtensa" / "src" / "esp32s3" / "esp-hal-3rdparty"
    if not hal_source.is_dir():
        if require_esp_hal:
            raise ValueError(f"找不到 ESP32S3 所需的本地 esp-hal-3rdparty: {hal_source}")
        return
    if hal_destination.is_symlink():
        hal_destination.unlink()
    elif hal_destination.exists():
        shutil.rmtree(hal_destination)
    copy_tree(hal_source, hal_destination, nuttx)


def apply_nuttx_compat_patches(tree: Path) -> None:
    """应用当前 NuttX 快照所需的最小头文件兼容修复。

    ESP32-S3 QSPI 驱动使用 NuttX 的 ALIGN_UP 宏，但部分上游快照只包含
    sys/param.h；将定义宏的公共头文件显式加入隔离快照，保证离线构建可重复。
    Wi-Fi 二进制必须与 HAL 头文件的锁定版本一致，禁止用弱桩掩盖 ABI 错配。
    """
    extraheaps = tree / "arch/xtensa/src/esp32s3/esp32s3_extraheaps.c"
    if extraheaps.is_file():
        text = extraheaps.read_text(encoding="utf-8")
        if '#include "xtensa.h"' not in text:
            anchor = "#include <nuttx/mm/mm.h>\n"
            if text.count(anchor) != 1:
                raise ValueError("内部专用堆初始化源码版本不匹配")
            extraheaps.write_text(text.replace(anchor, anchor + '\n#include "xtensa.h"\n', 1), encoding="utf-8")

    # NuttX 的 ESP32-S3 旧快照把 `.ext_ram.bss` 大小同时从 PSRAM 映射区
    # 两端扣除。PixelBox 的 MultiNet 工作区位于映射区首端，这会让 8 MiB
    # PSRAM 在工作区为 4 MiB 时得到零长度通用堆，连 littlefs mount 都会
    # 因 malloc 失败退出。隔离快照只需保留工作区后的剩余区间。
    spiram = tree / "arch/xtensa/src/esp32s3/esp32s3_spiram.c"
    if spiram.is_file():
        text = spiram.read_text(encoding="utf-8")
        old = """  g_allocable_vaddr_start = g_mapped_vaddr_start + ext_bss_size;
  g_allocable_vaddr_end = g_mapped_vaddr_start + g_mapped_size -
                          ext_bss_size;
"""
        new = """  /* `.ext_ram.bss` starts at the mapped PSRAM base in the flat
   * linker layout. Keep the rest of PSRAM available to the common heap;
   * subtracting the section from both ends makes an 8 MiB/4 MiB layout
   * empty and causes every early malloc (including littlefs mount) to fail.
   */
  g_allocable_vaddr_start = g_mapped_vaddr_start + ext_bss_size;
  g_allocable_vaddr_end = g_mapped_vaddr_start + g_mapped_size;
"""
        if old in text:
            text = text.replace(old, new, 1)
        elif "g_allocable_vaddr_start = g_mapped_vaddr_start + ext_bss_size;" in text and \
             "g_allocable_vaddr_end = g_mapped_vaddr_start + g_mapped_size;" not in text:
            raise ValueError("ESP32-S3 PSRAM 可分配区间代码版本不匹配")
        if text != spiram.read_text(encoding="utf-8"):
            spiram.write_text(text, encoding="utf-8")

    qspi = tree / "arch" / "xtensa" / "src" / "esp32s3" / "esp32s3_qspi.c"
    if qspi.is_file():
        text = qspi.read_text(encoding="utf-8")
        include = "#include <nuttx/nuttx.h>"
        if include not in text:
            anchor = "#include <nuttx/config.h>\n"
            if anchor not in text:
                raise ValueError(f"ESP32-S3 QSPI 驱动缺少配置头文件: {qspi}")
            text = text.replace(anchor, anchor + "\n" + include + "\n", 1)
        wait = (
            "  esp32s3_qspi_wait_sem(priv);\n\n"
            "  /* Reset interrupt */\n\n"
            "  putreg32(0, SPI_DMA_INT_ENA_REG(id));\n\n"
            "  return 0;"
        )
        # 超时必须传递到 FBIO_UPDATE；否则一帧可静默等待240次后谎报成功。
        checked_wait = wait.replace("  esp32s3_qspi_wait_sem(priv);",
                                    "  int result = esp32s3_qspi_wait_sem(priv);")
        checked_wait = checked_wait.replace("  return 0;", "  return result;")
        if wait in text:
            text = text.replace(wait, checked_wait, 1)
        elif "static int esp32s3_qspi_memory(" in text and checked_wait not in text:
            raise ValueError("QSPI DMA 等待代码版本不匹配，无法确认超时错误已向上传递")
        if text != qspi.read_text(encoding="utf-8"):
            qspi.write_text(text, encoding="utf-8")

    # 清除旧隔离快照为错版 IDF 5.5 二进制添加的桩；不能靠伪造结构修补 ABI。
    wifi_adapter = tree / "arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c"
    if wifi_adapter.is_file():
        text = wifi_adapter.read_text(encoding="utf-8")
        start_marker = "/*\n * The ESP-HAL archives bundled for ESP32-S3 expose these entry points with"
        end_marker = "/****************************************************************************\n * Functions needed by libcoexist.a\n ****************************************************************************/"
        if start_marker in text:
            start = text.index(start_marker)
            end = text.find(end_marker, start)
            if end < 0 or "regdomain_table[1] = { 0 };" not in text[start:end]:
                raise ValueError("旧版 Wi-Fi 兼容桩结构变化，拒绝不确定删除")
            text = text[:start] + text[end:]
            wifi_adapter.write_text(text, encoding="utf-8")

    wireless = tree / "arch/xtensa/src/common/espressif/Wireless.mk"
    if wireless.is_file():
        text = wireless.read_text(encoding="utf-8")
        text = text.replace(" -lespnow -lmesh -lsmartconfig", "")
        text = text.replace("# ESP32-S3 的离线 ESP-HAL 将扩展功能拆成独立归档；这些库包含\n"
                            "# esp_wifi_* 公共入口、ESP-NOW、mesh、smartconfig 及其监管域数据。\n", "")
        if text != wireless.read_text(encoding="utf-8"):
            wireless.write_text(text, encoding="utf-8")

    apply_board_device_patches(tree)
    apply_simple_boot_digest_patch(tree)
    if (tree / "arch/xtensa/src/esp32s3/esp32s3_start.c").is_file():
        subprocess.run([sys.executable, str(Path(__file__).with_name("simple_boot_patch.py")),
                        str(tree)], check=True, timeout=60)
        # 仅隔离快照接入QE和早期RAM段；ROM仍按DIO加载，再由官方流程切QIO。
        subprocess.run([sys.executable, str(Path(__file__).with_name("simpleboot_qio_patch.py")),
                        str(tree)], check=True, timeout=60)
    subprocess.run([sys.executable, str(Path(__file__).with_name("usbserial_patch.py")),
                    str(tree)], check=True, timeout=60)
    if all((tree / path).is_file() for path in (
            "arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c",
            "arch/xtensa/src/common/espressif/esp_wireless.c",
            "arch/xtensa/src/common/espressif/esp_wlan.c")):
        subprocess.run([sys.executable, str(Path(__file__).with_name("wifi_debug_patch.py")),
                        str(tree)], check=True, timeout=60)
    if wireless.is_file() and "MBEDTLS_CONFIG_FILE" in wireless.read_text(encoding="utf-8"):
        subprocess.run([sys.executable, str(Path(__file__).with_name("tls_build_patch.py")),
                        str(tree)], check=True, timeout=60)


def apply_board_device_patches(tree: Path) -> None:
    """只修隔离快照：板载 codec 独占 pcm0，扫描保留真实认证类型。"""
    if (tree / "drivers/audio/es8311.c").is_file():
        subprocess.run([sys.executable, str(Path(__file__).with_name("es8311_patch.py")),
                        str(tree)], check=True, timeout=60)
    if (tree / "arch/xtensa/src/esp32s3/esp32s3_i2s.c").is_file():
        subprocess.run([sys.executable, str(Path(__file__).with_name("i2s_capture_patch.py")),
                        str(tree)], check=True, timeout=60)
    bringup = tree / "boards/xtensa/esp32s3/esp32s3-devkit/src/esp32s3_bringup.c"
    if bringup.is_file():
        original = bringup.read_text(encoding="utf-8")
        anchor = (
            "  /* Configure I2S generic audio on I2S0 */\n\n"
            "  ret = board_i2sdev_initialize(ESP32S3_I2S0, i2s_enable_tx, i2s_enable_rx);\n"
            "  if (ret < 0)\n"
            "    {\n"
            '      syslog(LOG_ERR, "Failed to initialize I2S0 driver: %d\\n", ret);\n'
            "    }"
        )
        replacement = (
            "#ifndef CONFIG_AUDIO_ES8311\n"
            "  /* ES8311 板级驱动负责 pcm0，不能提前注册无 codec 的通用输出。 */\n"
            + anchor + "\n#endif"
        )
        if replacement not in original:
            if original.count(anchor) != 1:
                raise ValueError("I2S0 bringup 版本不匹配，拒绝重复注册 pcm0")
            bringup.write_text(original.replace(anchor, replacement, 1), encoding="utf-8")

    scan = tree / "arch/xtensa/src/common/espressif/esp_wifi_utils.c"
    if scan.is_file():
        original = scan.read_text(encoding="utf-8")
        anchor = "              iwe->u.data.flags = IW_ENCODE_ENABLED | IW_ENCODE_NOKEY;"
        replacement = (
            "              iwe->u.data.flags =\n"
            "                ap_list_buffer[bss_count].authmode == WIFI_AUTH_OPEN\n"
            "                ? IW_ENCODE_DISABLED\n"
            "                : IW_ENCODE_ENABLED | IW_ENCODE_NOKEY;"
        )
        if replacement not in original:
            if original.count(anchor) != 1:
                raise ValueError("Wi-Fi 扫描认证字段版本不匹配")
            scan.write_text(original.replace(anchor, replacement, 1), encoding="utf-8")


def apply_simple_boot_digest_patch(tree: Path) -> None:
    """成对修复快照中的镜像生成与加载，不修改用户的上游 SDK。"""
    loader = tree / "arch/xtensa/src/common/espressif/esp_loader.c"
    makefile = tree / "tools/esp32s3/Config.mk"
    if not loader.is_file() and not makefile.is_file():
        return  # 轻量级 runner 单测无需包含整棵 ESP32-S3 源码。
    if not loader.is_file() or not makefile.is_file():
        raise ValueError("Simple Boot 快照缺少 esp_loader.c 或 ESP32-S3 Config.mk")
    loader_text = loader.read_text(encoding="utf-8")
    make_text = makefile.read_text(encoding="utf-8")
    anchor = (
        "          offset += (CHECKSUM_ALIGN - 1) - (offset % CHECKSUM_ALIGN) + 1;\n"
        "          padding_checksum = true;"
    )
    replacement = (
        "          offset += (CHECKSUM_ALIGN - 1) - (offset % CHECKSUM_ALIGN) + 1;\n"
        "          /* ROM 摘要位于 checksum 后；跳过后才能继续解析 Flash 段。 */\n"
        "          if (image_header.hash_appended)\n"
        "            {\n"
        "              offset += 32;\n"
        "            }\n"
        "\n"
        "          padding_checksum = true;"
    )
    image_command = "\tesptool.py -c esp32s3 elf2image $(ELF2IMAGE_OPTS) -o nuttx.bin nuttx\n"
    digest_command = "\t$(Q) python3 tools/pixelbox_simple_boot_image.py nuttx.bin\n"
    if replacement not in loader_text:
        if loader_text.count(anchor) != 1:
            raise ValueError("Simple Boot loader 版本不匹配，无法安全添加 SHA-256 跳过逻辑")
        loader_text = loader_text.replace(anchor, replacement, 1)
    if digest_command not in make_text:
        if make_text.count(image_command) != 1:
            raise ValueError("Simple Boot MKIMAGE 版本不匹配，无法安全添加 SHA-256 生成步骤")
        make_text = make_text.replace(image_command, image_command + digest_command, 1)

    # 生成摘要与加载摘要必须同时启用；Make flash 重新生成镜像时也执行相同校验。
    tool = Path(__file__).with_name("simple_boot_image.py")
    staged_tool = tree / "tools/pixelbox_simple_boot_image.py"
    if not staged_tool.is_file() or staged_tool.read_bytes() != tool.read_bytes():
        shutil.copy2(tool, staged_tool)
    if loader_text != loader.read_text(encoding="utf-8"):
        loader.write_text(loader_text, encoding="utf-8")
    if make_text != makefile.read_text(encoding="utf-8"):
        makefile.write_text(make_text, encoding="utf-8")

def _littlefs_archive(root: Path) -> Path:
    """定位本地 LittleFS 归档；构建阶段不允许通过 curl 获取依赖。"""
    candidates: list[Path] = []
    configured = os.environ.get("NUTTX_LITTLEFS_ARCHIVE")
    if configured:
        candidates.append(Path(configured).expanduser())
    # 验证环境会预置该归档；工程目录下的 cache 位置便于 IDE/CI 携带依赖。
    candidates.extend((
        root / "third_party" / f"littlefs-{LITTLEFS_VERSION}.tar.gz",
        root / "deps" / f"littlefs-{LITTLEFS_VERSION}.tar.gz",
        Path("/private/tmp/pixelbox-nuttx-validation") / f"littlefs-{LITTLEFS_VERSION}.tar.gz",
    ))
    for candidate in candidates:
        if candidate.is_file():
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            if digest != LITTLEFS_SHA256:
                raise ValueError(
                    f"LittleFS 归档 SHA-256 不匹配: {candidate} (得到 {digest})")
            return candidate.resolve()
    shown = os.environ.get("NUTTX_LITTLEFS_ARCHIVE", "未设置")
    raise ValueError(
        f"缺少 LittleFS {LITTLEFS_VERSION} 离线归档；请设置 NUTTX_LITTLEFS_ARCHIVE "
        f"（当前值: {shown}），禁止构建阶段联网下载")


def _safe_unpack_littlefs(archive: Path, destination: Path) -> None:
    """安全解压固定根目录归档，拒绝路径穿越、链接和异常根目录。"""
    expected_root = f"{LITTLEFS_ROOT}/"
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        if not members or any(member.name != expected_root.rstrip("/") and
                              not member.name.startswith(expected_root)
                              for member in members):
            raise ValueError(
                f"LittleFS 归档根目录必须为 {expected_root}: {archive}")
        for member in members:
            relative = Path(member.name[len(expected_root):])
            if not relative.parts:
                continue
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"LittleFS 归档包含越界路径: {member.name}")
            target = (destination / relative).resolve()
            if destination.resolve() not in target.parents:
                raise ValueError(f"LittleFS 归档包含越界路径: {member.name}")
            if member.issym() or member.islnk():
                raise ValueError(f"LittleFS 归档不允许符号链接: {member.name}")
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise ValueError(f"LittleFS 归档包含不支持的条目: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            source = tar.extractfile(member)
            if source is None:
                raise ValueError(f"无法读取 LittleFS 归档条目: {member.name}")
            with target.open("wb") as output:
                shutil.copyfileobj(source, output)


def _enable_offline_hal_make_defs(tree: Path) -> None:
    """让隔离快照的 ESP32-S3 Make.defs 跳过所有 Git/联网依赖。"""
    make_defs = tree / "arch" / "xtensa" / "src" / "esp32s3" / "Make.defs"
    if not make_defs.is_file():
        raise ValueError(f"ESP32-S3 快照缺少 Make.defs: {make_defs}")
    text = make_defs.read_text(encoding="utf-8")
    if "NUTTX_ESP_HAL_OFFLINE" in text:
        return
    start = text.find("context:: chip/$(ESP_HAL_3RDPARTY_REPO)\n")
    end = text.find("distclean::", start)
    if start < 0 or end < 0:
        raise ValueError(f"无法定位 ESP HAL context 规则: {make_defs}")
    block = text[start:end]
    if "git -C chip/$(ESP_HAL_3RDPARTY_REPO) submodule" not in block or \
            "git apply ../../../nuttx/patches/components/mbedtls/mbedtls/*.patch" not in block:
        raise ValueError(f"ESP HAL Make.defs 版本不受离线补丁支持: {make_defs}")
    replacement = (
        "context:: chip/$(ESP_HAL_3RDPARTY_REPO)\n"
        "ifeq ($(CONFIG_ESPRESSIF_WIRELESS),y)\n"
        "ifeq ($(NUTTX_ESP_HAL_OFFLINE),1)\n"
        "\t$(Q) echo \"Using offline ESP HAL dependencies\"\n"
        "else\n"
        "\t$(Q) echo \"Espressif HAL for 3rd Party Platforms: initializing submodules...\"\n"
        "\t$(Q) git -C chip/$(ESP_HAL_3RDPARTY_REPO) submodule --quiet update --init $(GIT_DEPTH_PARAMETER) components/mbedtls/mbedtls components/esp_phy/lib components/esp_wifi/lib components/bt/controller/lib_esp32c3_family components/esp_coex/lib\n"
        "\t$(Q) git -C chip/$(ESP_HAL_3RDPARTY_REPO)/components/mbedtls/mbedtls reset --quiet --hard\n"
        "\t$(Q) echo \"Applying patches...\"\n"
        "\t$(Q) cd chip/$(ESP_HAL_3RDPARTY_REPO)/components/mbedtls/mbedtls && git apply ../../../nuttx/patches/components/mbedtls/mbedtls/*.patch\n"
        "endif\n"
        "endif\n\n"
    )
    make_defs.write_text(text[:start] + replacement + text[end:], encoding="utf-8")


def _materialize_esp_hal(root: Path, tree: Path) -> bool:
    """复制并校验受控 ESP32-S3 无线库，然后应用 NuttX 的 mbedTLS 补丁。"""
    hal = tree / ESP_HAL_REPO_RELATIVE
    if not hal.is_dir():
        return False
    # 在复制任何二进制前检查 ABI 头文件；错版时必须终止，不能靠链接桩补过去。
    for relative, expected in ESP_HAL_HEADER_SHA256.items():
        header = hal / relative
        if not header.is_file() or hashlib.sha256(header.read_bytes()).hexdigest() != expected:
            raise ValueError(f"ESP HAL 头文件 ABI 不匹配: {header}")
    dependency_root = root / "third_party" / ESP_HAL_DEPENDENCY_ROOT
    if dependency_root.is_symlink() or not dependency_root.is_dir():
        raise ValueError(f"缺少受控 ESP HAL 依赖目录: {dependency_root}")
    copied: dict[str, str] = {}
    for relative, expected in ESP_HAL_LIBRARY_SHA256.items():
        source = dependency_root / relative
        if source.is_symlink() or not source.is_file():
            raise ValueError(f"缺少 ESP32-S3 无线库: {source}")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        if digest != expected:
            raise ValueError(f"ESP HAL 库 SHA-256 不匹配: {source} (得到 {digest})")
        destination = hal / relative
        if destination.is_symlink():
            destination.unlink()
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        copied[relative] = digest

    marker = hal / ESP_HAL_OFFLINE_MARKER
    mbedtls = hal / "components" / "mbedtls" / "mbedtls"
    patches_root = hal / "nuttx" / "patches" / "components" / "mbedtls" / "mbedtls"
    if not mbedtls.is_dir() or not patches_root.is_dir():
        raise ValueError(f"ESP HAL 快照缺少 mbedTLS 源码或补丁: {mbedtls}")
    if not marker.is_file():
        patches = sorted(patches_root.glob("*.patch"))
        if not patches:
            raise ValueError(f"ESP HAL 快照缺少 mbedTLS 补丁: {patches_root}")
        for patch_file in patches:
            subprocess.run(["patch", "-p1", "--batch", "--forward", "-d",
                            str(mbedtls), "-i", str(patch_file.resolve())], check=True)
        marker.touch()
    _enable_offline_hal_make_defs(tree)
    return True


def prepare_offline_dependencies(root: Path, tree: Path) -> None:
    """预置 HAL/LittleFS 外部源码，使 NuttX Make 完全离线。"""
    hal_ready = _materialize_esp_hal(root, tree)
    littlefs_root = tree / "fs" / "littlefs"
    # 最小化 runner 单测或不启用 LittleFS 的 NuttX profile 不包含该目录，
    # 不应因为 ESP32 专用离线依赖检查改变通用源码快照行为。
    if not littlefs_root.is_dir():
        if hal_ready:
            (tree / OFFLINE_DEPS_FILE).write_text(json.dumps({
                "espHal": {"libraries": ESP_HAL_LIBRARY_SHA256, "offline": True},
            }, indent=2) + "\n", encoding="utf-8")
        return
    archive = _littlefs_archive(root)
    unpacked = littlefs_root / "littlefs"
    marker = unpacked / ".git"
    archive_target = littlefs_root / f"{LITTLEFS_VERSION}.tar.gz"
    if marker.is_dir() and archive_target.is_file():
        current = hashlib.sha256(archive_target.read_bytes()).hexdigest()
        if current == LITTLEFS_SHA256:
            return
    if unpacked.is_symlink() or (unpacked.exists() and not unpacked.is_dir()):
        raise ValueError(f"LittleFS 目录不能是符号链接或普通文件: {unpacked}")
    if unpacked.exists():
        shutil.rmtree(unpacked)
    staging = littlefs_root / f".littlefs-{LITTLEFS_VERSION}.staging"
    if staging.exists() or staging.is_symlink():
        if staging.is_symlink():
            staging.unlink()
        else:
            shutil.rmtree(staging)
    staging.mkdir(parents=True, exist_ok=True)
    _safe_unpack_littlefs(archive, staging)
    extracted = staging / "lfs.c"
    if not extracted.is_file() or not (staging / "lfs.h").is_file():
        shutil.rmtree(staging)
        raise ValueError(f"LittleFS 归档内容不完整: {archive}")
    patch_files = [littlefs_root / name for name in
                   ("lfs_util.patch", "lfs_getpath.patch", "lfs_getsetattr.patch")]
    for patch_file in patch_files:
        if not patch_file.is_file():
            shutil.rmtree(staging)
            raise ValueError(f"缺少 NuttX LittleFS 补丁: {patch_file}")
    # 补丁路径以 ./littlefs/littlefs/... 开头，-p3 后对应 staging 下的文件。
    for patch_file in patch_files:
        subprocess.run(["patch", "-p3", "-d", str(staging), "-i",
                        str(patch_file.resolve())], check=True)
    staging.rename(unpacked)
    marker.mkdir()
    shutil.copy2(archive, archive_target)
    metadata = {"littlefs": {"version": LITTLEFS_VERSION, "sha256": LITTLEFS_SHA256,
                              "archive": str(archive)}}
    if hal_ready:
        metadata["espHal"] = {"libraries": ESP_HAL_LIBRARY_SHA256, "offline": True}
    (tree / OFFLINE_DEPS_FILE).write_text(json.dumps(metadata, indent=2) + "\n",
                                          encoding="utf-8")


def read_state(build: Path) -> dict:
    try:
        state = json.loads((build / STATE_FILE).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return state if isinstance(state, dict) else {}


def board_overlay(root: Path, target: str, board: str) -> tuple[Path | None, dict]:
    """返回板级覆盖目录及稳定摘要；覆盖只从工程复制到隔离快照。"""
    board_name = board.split(":", 1)[0]
    overlay = root / "boards" / "xtensa" / target / board_name
    if not overlay.is_dir():
        return None, {"path": str(overlay), "files": 0, "sha256": None, "entries": []}
    digest = hashlib.sha256()
    files: list[str] = []
    for source in sorted(path for path in overlay.rglob("*") if path.is_file()):
        relative = source.relative_to(overlay).as_posix()
        files.append(relative)
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(source.read_bytes())
        digest.update(b"\0")
    return overlay, {"path": str(overlay), "files": len(files),
                     "sha256": digest.hexdigest(), "entries": files}


def apply_board_overlay(tree: Path, target: str, overlay: Path | None) -> None:
    """将工程板级文件复制进快照，禁止通过符号链接写回 SDK。"""
    if overlay is None:
        return
    destination = tree / "boards" / "xtensa" / target / overlay.name
    if destination.is_symlink():
        raise ValueError(f"板级目录不能是符号链接: {destination}")
    destination.mkdir(parents=True, exist_ok=True)
    for source in sorted(overlay.rglob("*")):
        relative = source.relative_to(overlay)
        output = destination / relative
        if source.is_symlink():
            raise ValueError(f"板级 overlay 不允许符号链接: {source}")
        if source.is_dir():
            if output.is_symlink():
                raise ValueError(f"板级目录不能是符号链接: {output}")
            output.mkdir(parents=True, exist_ok=True)
            continue
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.is_symlink():
            raise ValueError(f"板级文件不能是符号链接: {output}")
        shutil.copy2(source, output)


def apply_portal_patches(root: Path, tree: Path, app_tree: Path,
                         enabled: bool, env: dict[str, str]) -> None:
    """只有显式开启门户才修补私有 SDK；普通 STA 构建保持原有路径。"""
    if not enabled:
        return
    run([sys.executable, str(root / "scripts/softap_adapter_patch.py"),
         str(tree / "arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c")], root, env)
    run([sys.executable, str(root / "scripts/portal_dhcp_patch.py"),
         str(app_tree / "netutils/dhcpd/dhcpd.c")], root, env)


def stage_application(root: Path, application: Path, *, multinet_enabled: bool = False) -> None:
    # Application.mk 把 .o/.depend 写在源文件旁边；只能链接单个文件，不能链接目录。
    # 这样头文件/源文件实时反映工作区修改，所有构建副产物仍落在 build/ 内。
    if application.is_symlink():
        if application.resolve() != root:
            raise ValueError("nuttx-apps 已含不同的 interpreters/pixelbox，拒绝覆盖")
        application.unlink()
    application.mkdir(parents=True, exist_ok=True)
    files = [root / name for name in ("Makefile", "Make.defs", "Kconfig")]
    for folder in ("src", "include", "generated", "vendor"):
        files.extend(path for path in (root / folder).rglob("*")
                     if path.is_file() and (path.suffix in (".c", ".h", ".js", ".inc") or path.name == "LICENSE"))
    if multinet_enabled:
        # 只登记生成器提供的模型对象；不能把其它旧 .o 当作源码带入新构建。
        for name in ("multinet7.o", "model.S", "srmodels.bin", "manifest.json"):
            source = root / "generated/wakeword" / name
            if not source.is_file():
                raise ValueError(f"缺少已准备的 MultiNet7 构建产物: {source}")
            files.append(source)
    for source in files:
        destination = application / source.relative_to(root)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.is_symlink():
            if destination.resolve() != source.resolve():
                raise ValueError(f"应用构建文件来源不一致: {destination}")
        elif destination.exists():
            raise ValueError(f"应用目录有非本工程文件，拒绝覆盖: {destination}")
        else:
            destination.symlink_to(source)


def build_dir(root: Path, target: str) -> Path:
    path = root / "build" / target
    # clean 只能处理本工程自己生成的目录，拒绝符号链接越界。
    if (root / "build").is_symlink() or path.is_symlink():
        raise ValueError("构建目录不能是符号链接")
    return path


def clean(root: Path, target: str) -> None:
    build = build_dir(root, target)
    if not build.exists():
        print("[nuttx] 构建目录为空")
        return
    entries = list(build.iterdir())
    if entries:
        state = read_state(build)
        if state.get("project") != str(root) or state.get("target") != target:
            raise ValueError("目录缺少本工程的构建标记，拒绝清理")
        # 首先失效完成标记；取消清理后不能误把残缺目录当成已配置的完整源码。
        for name in (".sources-ready", ".configured"):
            (build / name).unlink(missing_ok=True)
        for entry in sorted(build.iterdir()):
            if entry.name == STATE_FILE:
                continue
            if entry.is_symlink() or not entry.is_dir():
                entry.unlink()
            else:
                shutil.rmtree(entry)
        # 归属标记留到最后；此后即使被终止，空目录也允许再次 clean。
        (build / STATE_FILE).unlink()
    build.rmdir()
    print(f"[nuttx] 已清理 {build}")


def prepare(root: Path, nuttx: Path, apps: Path, target: str, board: str,
            make: str, env: dict[str, str]) -> Path:
    build = build_dir(root, target)
    chip = PROFILE_BASES.get(target, target)
    overlays = [root / "configs" / f"{name}.config"
                for name in ([chip, target] if chip != target else [target])]
    digest = hashlib.sha256(b"\0".join(path.read_bytes() for path in overlays)).hexdigest()
    requested = {}
    for overlay in overlays:
        requested.update(parse_config(overlay.read_text(encoding="utf-8")))
    portal_requested = requested.get("CONFIG_INTERPRETERS_PIXELBOX_PORTAL") == "y"
    multinet_requested = requested.get("CONFIG_INTERPRETERS_PIXELBOX_MULTINET7") == "y"
    sleep_requested = requested.get("CONFIG_INTERPRETERS_PIXELBOX_TIMED_SLEEP") == "y"
    board_dir, board_summary = board_overlay(root, chip, board)
    expected = {"project": str(root), "target": target, "board": board,
                "nuttx": str(nuttx), "apps": str(apps), "profile": digest,
                "boardOverlay": board_summary}
    state = read_state(build)
    # 仅板级已有文件内容变化时可增量复制；配置、来源、文件集合变化仍须重配。
    board_refresh = bool(state and state != expected and
                         {k: v for k, v in state.items() if k != "boardOverlay"} ==
                         {k: v for k, v in expected.items() if k != "boardOverlay"} and
                         isinstance(state.get("boardOverlay"), dict) and board_summary and
                         state["boardOverlay"].get("path") == board_summary["path"] and
                         state["boardOverlay"].get("entries") == board_summary["entries"])
    if build.exists() and any(build.iterdir()) and state != expected:
        if not board_refresh:
            raise ValueError("构建来源或配置已改变；先运行 clean，再重新构建（保留用户源码）")
    if not state:
        build.mkdir(parents=True, exist_ok=True)
        # 先记录归属，失败或取消后依然能安全执行 clean。
        (build / STATE_FILE).write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
    tree = build / "nuttx"
    app_tree = build / "apps"
    # 中断的复制不得被视为完整源码；仅在两棵快照都完成后记录完成标记。
    if not (build / ".sources-ready").is_file():
        print("[nuttx] 准备工程专用内核和 apps 源码…", flush=True)
        # 轻量级 runner 单测可只提供最小源码树；完整 ESP32-S3 SDK 含有
        # arch/xtensa/src/chip 时才强制要求离线 HAL 预置。
        require_esp_hal = chip == "esp32s3" and (
            nuttx / "arch" / "xtensa" / "src" / "chip").is_dir()
        copy_sources(nuttx, apps, tree, app_tree, require_esp_hal=require_esp_hal)
        # 板级代码必须在隔离快照内覆盖，不能让 configure 或 Make 触碰 .deps/nuttx。
        apply_board_overlay(tree, chip, board_dir)
        prepare_offline_dependencies(root, tree)
        (build / ".sources-ready").touch()
    else:
        print("[nuttx] 复用工程内 SDK 快照；若原 NuttX/apps 同路径更新，请先运行 clean 再构建。", flush=True)
        # 增量构建同样核对 ABI 与二进制，不能继续使用旧快照中的错版无线库。
        if _materialize_esp_hal(root, tree):
            metadata_path = tree / OFFLINE_DEPS_FILE
            metadata = json.loads(metadata_path.read_text()) if metadata_path.is_file() else {}
            metadata["espHal"] = {"headers": ESP_HAL_HEADER_SHA256,
                                  "libraries": ESP_HAL_LIBRARY_SHA256, "offline": True}
            metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")
    if board_refresh:
        apply_board_overlay(tree, chip, board_dir)
        (build / STATE_FILE).write_text(json.dumps(expected, indent=2) + "\n", encoding="utf-8")
        print("[nuttx] 已增量更新板级源码；构建来源和配置未变。", flush=True)
    apply_nuttx_compat_patches(tree)
    apply_portal_patches(root, tree, app_tree, portal_requested, env)
    if requested.get("CONFIG_NIMBLE") == "y":
        # 固定依赖和控制器修补必须先于 configure/context，且只写私有快照。
        run([sys.executable, str(root / "tools/prepare_ble.py"),
             str(root), str(tree), str(app_tree)], root, env)
        run([sys.executable, str(root / "tools/prepare_ble_tx.py"),
             str(root), str(tree)], root, env)
    run([sys.executable, str(root / "tools/prepare.py")], root, env)
    if multinet_requested:
        compiler = discover_toolchain()
        if compiler is None:
            raise ValueError("MultiNet7 需要与 NuttX 相同的 Xtensa 工具链")
        run([sys.executable, str(root / "tools/prepare_wakeword.py"),
             "--repo-root", str(root.parent), "--output", str(root / "generated"),
             "--cc", str(compiler[0] / compiler[1])], root, env)
    stage_application(root, app_tree / "interpreters/pixelbox", multinet_enabled=multinet_requested)
    config = tree / ".config"
    if not (build / ".configured").is_file():
        host = "-m" if sys.platform == "darwin" else "-l"
        if not config.exists():
            run(["bash", "tools/configure.sh", host, "-a", "../apps", board], tree, env)
        elif not (tree / ".config.orig").exists():
            # configure 在 sethost 阶段失败时，.config 已存在但宿主配置尚不完整。
            run(["bash", "tools/sethost.sh", host], tree, env)
        for overlay in overlays:
            apply_overlay(config, overlay)
        run([make, "olddefconfig"], tree, env)
        validate_config(config, portal_requested=portal_requested, multinet_requested=multinet_requested,
                        sleep_requested=sleep_requested)
        (build / ".configured").touch()
    else:
        validate_config(config, portal_requested=portal_requested, multinet_requested=multinet_requested,
                        sleep_requested=sleep_requested)
    return tree


def validate_flash_image(binary: Path, config: Path) -> dict[str, str]:
    """按实际擦除扇区检查单镜像边界，并校验已经生成的 ROM 摘要。"""
    if not binary.is_file() or binary.stat().st_size == 0:
        raise ValueError("NuttX 构建未生成 nuttx.bin，不能报告构建成功")
    values = validate_config(config)
    erase_size = ((binary.stat().st_size + FLASH_SECTOR_SIZE - 1) //
                  FLASH_SECTOR_SIZE) * FLASH_SECTOR_SIZE
    if FLASH_IMAGE_OFFSET + erase_size > FLASH_STORAGE_OFFSET:
        raise ValueError("固件镜像擦除范围超过 0x800000 存储区起始地址，拒绝打包/烧录以防覆盖应用数据")
    # 产物必须已由 MKIMAGE 完成摘要生成；这里仅校验，不能掩盖旧 loader 构建。
    run([sys.executable, str(Path(__file__).with_name("simple_boot_image.py")),
         "--check", str(binary)], binary.parent)
    return values


def validate_internal_heap(elf: Path, config: Path) -> dict:
    """使用目标工具链检查内部堆；缺失 ELF、符号或工具时禁止发布。"""
    compiler = discover_toolchain()
    if compiler is None:
        raise ValueError("内部堆门禁需要 ESP32-S3 工具链及其 nm")
    nm = compiler[0] / (compiler[1].removesuffix("gcc") + "nm")
    if not nm.is_file() or not os.access(nm, os.X_OK):
        raise ValueError(f"内部堆门禁缺少目标工具链 nm: {nm}")
    command = [sys.executable, str(Path(__file__).with_name("check_internal_heap.py")),
               "--elf", str(elf), "--config", str(config), "--nm", str(nm),
               "--rom-reserved-start", hex(INTERNAL_HEAP_ROM_START),
               "--minimum-tail", str(INTERNAL_HEAP_MINIMUM_TAIL)]
    try:
        process = subprocess.run(command, capture_output=True, text=True, timeout=40)
        report = json.loads(process.stdout)
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        raise ValueError(f"内部堆门禁无法完成: {error}") from error
    if not isinstance(report, dict) or process.returncode != 0 or report.get("pass") is not True:
        detail = report.get("error", "无有效检查结果") if isinstance(report, dict) else "无有效检查结果"
        raise ValueError(f"内部堆门禁失败，拒绝打包/烧录: {detail}")
    report["rom_endpoint_source"] = INTERNAL_HEAP_ROM_SOURCE
    print(f"[nuttx] 内部堆通过: _sheap={report['_sheap']:#x}, "
          f"size={report['imem_region_size']:#x}, 剩余 DRAM={report['tail_bytes']} 字节", flush=True)
    return report


def collect_heap_evidence(binary: Path, elf: Path, config: Path, report: dict) -> None:
    """将通过门禁的 ELF/配置与镜像摘要绑定，防止后续使用另一轮构建的布局。"""
    elf_copy, config_copy = binary.with_suffix(".elf"), binary.with_suffix(".config")
    for source, destination in ((elf, elf_copy), (config, config_copy)):
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
    evidence = dict(report, schemaVersion=1, elf=elf_copy.name, config=config_copy.name,
                    imageSha256=hashlib.sha256(binary.read_bytes()).hexdigest(),
                    elfSha256=hashlib.sha256(elf_copy.read_bytes()).hexdigest(),
                    configSha256=hashlib.sha256(config_copy.read_bytes()).hexdigest())
    binary.with_suffix(".heap.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n",
                                               encoding="utf-8")


def validate_heap_evidence(binary: Path, staged: Path) -> dict:
    """重验已收集镜像的配套产物，不猜测当前 Make 工作树中的 ELF。"""
    try:
        evidence = json.loads(binary.with_suffix(".heap.json").read_text(encoding="utf-8"))
        if not isinstance(evidence, dict) or evidence.get("schemaVersion") != 1 or evidence.get("pass") is not True:
            raise ValueError("配套内部堆检查记录无效")
        if evidence.get("rom_reserved_start") != INTERNAL_HEAP_ROM_START:
            raise ValueError("配套内部堆检查的 ROM 端点不适用于当前板型")
        elf, config = binary.with_suffix(".elf"), binary.with_suffix(".config")
        for path, key in ((staged, "imageSha256"), (elf, "elfSha256"), (config, "configSha256")):
            if hashlib.sha256(path.read_bytes()).hexdigest() != evidence.get(key):
                raise ValueError(f"配套内部堆产物摘要不匹配: {key}")
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"缺少有效的内部堆配套产物，请重新构建: {error}") from error
    return validate_internal_heap(elf, config)


def collect(root: Path, tree: Path, target: str, package: bool) -> None:
    binary = tree / "nuttx.bin"
    validate_flash_image(binary, tree / ".config")
    heap_report = validate_internal_heap(tree / "nuttx", tree / ".config")
    output = root / "build" / target
    captures = sorted((output / "commands").glob("*.json"))
    if captures:
        commands = [json.loads(path.read_text(encoding="utf-8")) for path in captures]
        (output / "compile_commands.json").write_text(json.dumps(commands, indent=2) + "\n", encoding="utf-8")
    shutil.copy2(binary, output / "nuttx.bin")
    collect_heap_evidence(output / "nuttx.bin", tree / "nuttx", tree / ".config", heap_report)
    for name in ("nuttx.map", "compile_commands.json"):
        source = tree / name
        if source.is_file():
            shutil.copy2(source, output / name)
    if package:
        dist = root / "dist"
        dist.mkdir(exist_ok=True)
        image = dist / f"{target}-nuttx.bin"
        shutil.copy2(binary, image)
        collect_heap_evidence(image, output / "nuttx.elf", output / "nuttx.config", heap_report)
        (dist / f"{target}-nuttx.json").write_text(json.dumps({
            "firmwareBackend": "nuttx", "target": target, "boot": "simple",
            "offset": "0x0", "image": image.name, "size": image.stat().st_size,
            "sha256": hashlib.sha256(image.read_bytes()).hexdigest(),
        }, indent=2) + "\n", encoding="utf-8")
        print(f"[nuttx] Simple Boot 单镜像: {image} (offset 0x0)")


def create_storage_image(tree: Path, config: Path, destination: Path,
                         env: dict[str, str]) -> None:
    """复用固件的 LittleFS 源码及几何参数，在访问串口前生成并重挂载验证。"""
    values = validate_config(config)
    if (values.get("CONFIG_FS_LITTLEFS") != "y" or
            values.get("CONFIG_FS_LITTLEFS_VERSION") != f'"{LITTLEFS_VERSION}"' or
            values.get("CONFIG_FS_LITTLEFS_MULTI_VERSION") == "y"):
        raise ValueError("格式化仅支持当前固件使用的 LittleFS v2.5.1 单版本配置")

    def number(key: str, minimum: int = 1, maximum: int = FLASH_STORAGE_SIZE) -> int:
        try:
            result = int(values[key], 0)
        except (KeyError, ValueError) as error:
            raise ValueError(f"格式化缺少有效配置: {key}") from error
        if not minimum <= result <= maximum:
            raise ValueError(f"格式化配置超出范围: {key}")
        return result

    # 与 NuttX lfs_vfs.c 的 MTD 几何换算保持一致，物理擦除扇区为 4096 字节。
    mtd_block = number("CONFIG_ESP32S3_SPIFLASH_MTD_BLKSIZE")
    read_size = mtd_block * number("CONFIG_FS_LITTLEFS_READ_SIZE_FACTOR")
    prog_size = mtd_block * number("CONFIG_FS_LITTLEFS_PROGRAM_SIZE_FACTOR")
    block_size = FLASH_SECTOR_SIZE * number("CONFIG_FS_LITTLEFS_BLOCK_SIZE_FACTOR")
    cache_size = mtd_block * number("CONFIG_FS_LITTLEFS_CACHE_SIZE_FACTOR")
    if (block_size > FLASH_STORAGE_SIZE or FLASH_STORAGE_SIZE % block_size or
            not 0 < read_size <= cache_size <= block_size or
            not 0 < prog_size <= cache_size or cache_size % read_size or
            cache_size % prog_size or block_size % cache_size):
        raise ValueError("LittleFS 格式化几何参数不兼容")
    block_count = FLASH_STORAGE_SIZE // block_size
    lookahead = number("CONFIG_FS_LITTLEFS_LOOKAHEAD_SIZE", 0)
    if lookahead == 0:
        lookahead = min(((block_count + 63) // 64) * 8, read_size)
    if lookahead == 0 or lookahead % 8:
        raise ValueError("LittleFS lookahead 必须为正的 8 字节倍数")
    cycles = number("CONFIG_FS_LITTLEFS_BLOCK_CYCLE", -1, 0x7fffffff)
    if cycles == 0:
        raise ValueError("LittleFS block_cycles 不能为 0")
    limits = {"NAME": number("CONFIG_FS_LITTLEFS_NAME_MAX", 6, 255),
              "FILE": number("CONFIG_FS_LITTLEFS_FILE_MAX", 1, 0x7fffffff),
              "ATTR": number("CONFIG_FS_LITTLEFS_ATTR_MAX", 0, 1022)}
    source = tree / "fs/littlefs/littlefs"
    required = [source / name for name in ("lfs.c", "lfs_util.c", "bd/lfs_rambd.c")]
    if not all(path.is_file() for path in required):
        raise ValueError("构建快照缺少 LittleFS 源码，请先完成构建")
    compiler = shutil.which("cc", path=env.get("PATH"))
    if not compiler:
        raise ValueError("格式化需要宿主 C 编译器 cc")
    helper = destination.parent / "littlefs-image"
    args = [compiler, "-std=c99", "-O2", "-DLFS_NO_MALLOC", "-I", str(source)]
    args += [f"-DLFS_{name}_MAX={value}" for name, value in limits.items()]
    args += [str(ROOT / "scripts/littlefs_image.c"), *(str(path) for path in required),
             "-o", str(helper)]
    subprocess.run(args, cwd=tree, env=env, check=True, timeout=60)
    subprocess.run([str(helper), str(destination), *(str(value) for value in
                    (read_size, prog_size, block_size, block_count, cache_size, lookahead, cycles))],
                   cwd=tree, env=env, check=True, timeout=30)
    if destination.stat().st_size != FLASH_STORAGE_SIZE:
        raise ValueError("LittleFS 镜像必须恰好覆盖 8 MiB 数据区")
    print(f"[nuttx] 格式化数据区: {FLASH_STORAGE_OFFSET:#x}.."
          f"{FLASH_STORAGE_OFFSET + FLASH_STORAGE_SIZE:#x}，将删除应用、设置和文件", flush=True)


def flash(tree: Path, binary: Path, esptool: Path, port: str, baud: int,
          env: dict[str, str], format_storage: bool = False) -> None:
    # 禁止再次 make flash：它会重建镜像，并能切换为填充整片 Flash 的 merged 产物。
    # 独立快照经过最终校验后直接交给 esptool，避免构建目录后续变化替换待写入文件。
    with tempfile.TemporaryDirectory(prefix=".pixelbox-flash-", dir=binary.parent) as temporary:
        image = Path(temporary) / "nuttx.bin"
        shutil.copyfile(binary, image)
        values = validate_flash_image(image, tree / ".config")
        validate_heap_evidence(binary, image)
        storage = Path(temporary) / "littlefs.bin"
        if format_storage:
            create_storage_image(tree, binary.with_suffix(".config"), storage, env)
        args = [str(esptool), "-c", "esp32s3", "-p", port, "-b", str(baud)]
        if any(values.get(key) == "y" for key in
               ("CONFIG_ESP32S3_ESPTOOLPY_NO_STUB", "CONFIG_ESPRESSIF_ESPTOOLPY_NO_STUB")):
            args.append("--no-stub")
        # 保留已校验的头部和 SHA-256；格式化镜像仅能写入固定的数据区。
        args += ["write_flash", "--flash_mode", "keep", "--flash_freq", "keep",
                 "--flash_size", "keep", f"{FLASH_IMAGE_OFFSET:#x}", str(image)]
        if format_storage:
            args += [f"{FLASH_STORAGE_OFFSET:#x}", str(storage)]
        run(args, tree, env)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("task", choices=TASKS)
    parser.add_argument("--nuttx-path", default=os.environ.get("NUTTX_PATH"))
    parser.add_argument("--apps-path", default=os.environ.get("NUTTX_APPS_PATH"))
    parser.add_argument("--target", choices=tuple(PROFILES), default="esp32s3")
    parser.add_argument("--port")
    parser.add_argument("--baud", type=int, default=921600)
    parser.add_argument("--format-storage", action="store_true",
                        help="烧录前格式化 LittleFS 数据分区，删除应用、设置和文件（默认保留）")
    parser.add_argument("--jobs", type=int, default=min(os.cpu_count() or 2, 8))
    opts = parser.parse_args(argv)
    root = ROOT.resolve()
    try:
        if opts.format_storage and opts.task != "flash":
            raise ValueError("--format-storage 仅允许用于 flash")
        if sys.platform == "win32":
            raise ValueError("NuttX 原生 Make 构建请在 WSL2/Linux 或 macOS 中运行")
        if opts.task == "clean":
            with project_lock(root):
                clean(root, opts.target)
            return 0
        # NuttX 上游 Make 会二次展开路径；即使 subprocess 使用 argv，也不能接受这些字符。
        safe_path = re.compile(r"^[A-Za-z0-9_./+@-]+$")
        if not safe_path.fullmatch(str(root)) or not safe_path.fullmatch(sys.executable):
            raise ValueError("NuttX Make 的工程和 Python 路径只能包含英文字母、数字、_./+@-，不能含空格、冒号或 shell 字符")
        if not opts.nuttx_path:
            raise ValueError("请设置 NUTTX_PATH 或传 --nuttx-path（NuttX 内核源码根目录）")
        nuttx = Path(opts.nuttx_path).expanduser().resolve()
        if not (nuttx / "tools/configure.sh").is_file() or not (nuttx / "Kconfig").is_file():
            raise ValueError(f"无效的 NuttX 源码目录: {nuttx}")
        if root == nuttx or root in nuttx.parents or nuttx in root.parents:
            raise ValueError("NuttX 源码目录必须独立于固件工程，避免递归复制")
        apps = find_apps(nuttx, opts.apps_path)
        if root == apps or root in apps.parents or apps in root.parents:
            raise ValueError("nuttx-apps 必须独立于固件工程")
        if opts.jobs < 1 or not 1200 <= opts.baud <= 4000000:
            raise ValueError("jobs 必须为正整数，baud 范围为 1200..4000000")
        if opts.task == "flash" and (not opts.port or not re.fullmatch(r"/dev/[A-Za-z0-9._/-]+", opts.port)):
            raise ValueError("flash 需要有效的 --port /dev/... 串口")
        manifest = json.loads((root / "pixelbox.json").read_text(encoding="utf-8"))
        if manifest.get("firmwareBackend") != "nuttx":
            raise ValueError("pixelbox.json 的 firmwareBackend 必须为 nuttx")
        board = manifest.get("nuttxBoard", PROFILES[opts.target])
        if board != PROFILES[opts.target]:
            raise ValueError(f"当前目标仅支持 profile {PROFILES[opts.target]}")
        make = shutil.which("gmake") or shutil.which("make")
        if not make:
            raise ValueError("未找到 GNU make")
        # 先检查构建脚本必需的宿主工具；项目内 flock shim 让 macOS 不必修改系统 PATH。
        project_tools = root / "tools"
        for tool in ("bash", "git"):
            if not shutil.which(tool):
                raise ValueError(f"PATH 缺少 {tool}；请按 README 准备独立 NuttX 工具链")
        flock = project_tools / "flock"
        if not (flock.is_file() and os.access(flock, os.X_OK)) and not shutil.which("flock"):
            raise ValueError("PATH 缺少 flock；macOS 请使用工程内 tools/flock 或安装兼容实现")
        # 构建子进程使用发现到的独立工具链和 Kconfig 前端，不依赖 ESP-IDF。
        toolchain = discover_toolchain()
        if not toolchain:
            raise ValueError("未找到 Xtensa 工具链；请设置 NUTTX_TOOLCHAIN_PATH/ESP32S3_TOOLCHAIN_PATH")
        kconfig = discover_kconfig_tools([
            project_tools,
            nuttx / "tools" / "kconfig-frontends" / "bin",
        ])
        if not kconfig:
            raise ValueError("未找到 kconfig-conf/kconfig-tweak；请设置 KCONFIG_FRONTENDS_PATH")
        kconfiglib = discover_kconfiglib()
        esptool = discover_esptool()
        if opts.task == "flash" and not esptool:
            raise ValueError("flash 需要 esptool.py；请设置 ESPTOOL_PATH 或将 esptool 加入 PATH")
        env = dict(os.environ)
        # 只依赖 PATH 中的独立交叉编译器及 Python 工具，不读取 IDF_PATH。
        env.pop("IDF_PATH", None)
        # 快照已由 prepare_offline_dependencies 完成依赖物化；Make 不得回退到 Git。
        env["NUTTX_ESP_HAL_OFFLINE"] = "1"
        # esptool 的版本检查由 `python3 tools/espressif/check_esptool.py` 执行；
        # 若先放 Kconfig 虚拟环境，它的 python3 会遮蔽含 esptool 的环境。
        prepend_path(env, [esptool.parent if esptool else None, kconfiglib,
                           project_tools, toolchain[0], kconfig[0]])
        # 让 Make 使用发现到的 Kconfig 前端，即使它不在用户登录 shell 的 PATH 中。
        env["KCONFIG_CONF"] = kconfig[1]
        env["KCONFIG_TWEAK"] = kconfig[2]
        if esptool:
            env["ESPTOOL_PATH"] = str(esptool)
        with project_lock(root):
            tree = prepare(root, nuttx, apps, opts.target, board, make, env)
            if opts.task == "configure":
                return 0
            env["PX_NUTTX_COMPDB"] = str(root / "build" / opts.target / "commands")
            capture = shlex.join([sys.executable, str(root / "scripts/cc_capture.py")])
            run([make, f"-j{opts.jobs}", f"CCACHE={capture}"], tree, env)
            collect(root, tree, opts.target, opts.task == "merge")
            if opts.task == "flash":
                flash(tree, root / "build" / opts.target / "nuttx.bin", esptool,
                      opts.port, opts.baud, env, format_storage=opts.format_storage)
        return 0
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"[nuttx] 错误: {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
