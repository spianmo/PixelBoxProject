"""构建隔离、配置/镜像边界和真实编译数据库的回归测试，无需交叉工具链。"""
import importlib.util
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import struct
import sys
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("nuttx_build", Path(__file__).parents[1] / "scripts/nuttx.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
IMAGE_SPEC = importlib.util.spec_from_file_location(
    "simple_boot_image", Path(__file__).parents[1] / "scripts/simple_boot_image.py")
image_tool = importlib.util.module_from_spec(IMAGE_SPEC)
IMAGE_SPEC.loader.exec_module(image_tool)


class BuildRunnerTests(unittest.TestCase):
    def test_kconfig_frontends_discover_project_dependencies_without_environment(self):
        project_root = self.root / "workspace" / "firmware-nuttx"
        project_root.mkdir(parents=True)
        dependency_bin = project_root.parent / ".deps" / "kconfig-bin"
        dependency_bin.mkdir(parents=True)
        for name in ("kconfig-conf", "kconfig-tweak"):
            tool = dependency_bin / name
            tool.write_text("#!/bin/sh\n")
            tool.chmod(0o755)
        with mock.patch.object(runner, "ROOT", project_root), \
                mock.patch.dict(os.environ, {"KCONFIG_FRONTENDS_PATH": ""}, clear=False):
            result = runner.discover_kconfig_tools()
        self.assertIsNotNone(result)
        self.assertEqual(result[0], dependency_bin)
        self.assertEqual(result[1], str(dependency_bin / "kconfig-conf"))
        self.assertEqual(result[2], str(dependency_bin / "kconfig-tweak"))

    def test_timed_sleep_requires_pm_and_permanent_idle_lock(self):
        config = self.root / ".config"
        required = {"CONFIG_INTERPRETERS_PIXELBOX_TIMED_SLEEP": "y", "CONFIG_PM": "y",
                    "CONFIG_ARCH_CHIP_ESP32S3": "y", "CONFIG_PM_GOVERNOR_EXPLICIT_RELAX": "-1"}
        for missing in required:
            values = {key: value for key, value in required.items() if key != missing}
            base = "".join(line for line in self.valid_config().splitlines(keepends=True)
                           if not line.startswith(missing + "="))
            config.write_text(base + "".join(f"{key}={value}\n" for key, value in values.items()))
            with self.subTest(missing=missing), self.assertRaises(ValueError):
                runner.validate_config(config, sleep_requested=True)
        config.write_text(self.valid_config() + "".join(f"{key}={value}\n" for key, value in required.items()))
        runner.validate_config(config, sleep_requested=True)

    def test_timed_sleep_default_profile_stays_disabled(self):
        project = Path(__file__).resolve().parents[1]
        values = runner.parse_config((project / "configs/esp32s3.config").read_text())
        self.assertNotEqual(values.get("CONFIG_INTERPRETERS_PIXELBOX_TIMED_SLEEP"), "y")
        self.assertNotEqual(values.get("CONFIG_PM"), "y")
        self.assertEqual(runner.PROFILE_BASES["esp32s3-timed-sleep"], "esp32s3")

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="pixelbox-runner-")
        self.root = Path(self.tmp.name).resolve()

    def tearDown(self):
        self.tmp.cleanup()

    def valid_config(self):
        return ('CONFIG_INTERPRETERS_PIXELBOX=y\nCONFIG_ESPRESSIF_SIMPLE_BOOT=y\n'
                'CONFIG_BUILD_FLAT=y\nCONFIG_INIT_ENTRYPOINT="pixelbox_boot_main"\n'
                'CONFIG_ARCH_CHIP="esp32s3"\nCONFIG_ARCH_CHIP_ESP32S3=y\n'
                'CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP=y\nCONFIG_XTENSA_IMEM_REGION_SIZE=0x30000\n'
                'CONFIG_ESP32S3_FLASH_16M=y\n'
                'CONFIG_ESP32S3_STORAGE_MTD_OFFSET=0x800000\n'
                'CONFIG_ESP32S3_STORAGE_MTD_SIZE=0x800000\n')

    def test_generated_prelude_rebuilds_runtime_without_c_source_change(self):
        project = Path(__file__).resolve().parents[1]
        appdir = self.root / "apps"
        appdir.mkdir()
        (appdir / "Make.defs").write_text("")
        (appdir / "Application.mk").write_text(
            "PREFIX =\nSUFFIX = .probe\nOBJEXT = .o\n"
            "all: src/runtime.c.probe.o\n"
            "src/runtime.c.probe.o: src/runtime.c\n\t@echo rebuilt-runtime\n")
        (self.root / "src").mkdir()
        (self.root / "generated").mkdir()
        paths = ["src/runtime.c", "generated/prelude_nuttx.h", "generated/prelude_core.h"]
        for name in paths:
            (self.root / name).write_text("fixture")
            os.utime(self.root / name, (100, 100))
        obj = self.root / "src/runtime.c.probe.o"
        obj.write_text("old object")
        os.utime(obj, (200, 200))
        command = ["make", "-s", "-f", str(project / "Makefile"), f"APPDIR={appdir}", "all"]
        before = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=5)
        self.assertEqual(before.returncode, 0, before.stderr)
        self.assertNotIn("rebuilt-runtime", before.stdout)
        os.utime(self.root / "generated/prelude_nuttx.h", (300, 300))
        after = subprocess.run(command, cwd=self.root, capture_output=True, text=True, timeout=5)
        self.assertEqual(after.returncode, 0, after.stderr)
        self.assertIn("rebuilt-runtime", after.stdout)

    def test_overlay_replaces_existing_options_without_duplicates(self):
        config = self.root / ".config"
        config.write_text('CONFIG_KEEP="value"\nCONFIG_BOOT=y\n# CONFIG_NEW is not set\n')
        overlay = self.root / "overlay"
        overlay.write_text("CONFIG_BOOT=n\nCONFIG_NEW=y\n")
        runner.apply_overlay(config, overlay)
        self.assertEqual(runner.parse_config(config.read_text()),
                         {"CONFIG_KEEP": '"value"', "CONFIG_BOOT": "n", "CONFIG_NEW": "y"})
        self.assertEqual(config.read_text().count("CONFIG_BOOT"), 1)

    def test_device_patches_are_idempotent_and_leave_sdk_untouched(self):
        sdk = Path(__file__).resolve().parents[2] / ".deps/nuttx"
        paths = ["boards/xtensa/esp32s3/esp32s3-devkit/src/esp32s3_bringup.c",
                 "arch/xtensa/src/common/espressif/esp_wifi_utils.c"]
        if not all((sdk / path).is_file() for path in paths):
            self.skipTest("local NuttX SDK is unavailable")
        originals = {}
        for path in paths:
            originals[path] = (sdk / path).read_bytes()
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(originals[path])
        runner.apply_board_device_patches(self.root)
        first = [(self.root / path).read_bytes() for path in paths]
        runner.apply_board_device_patches(self.root)
        self.assertEqual(first, [(self.root / path).read_bytes() for path in paths])
        self.assertIn(b"#ifndef CONFIG_AUDIO_ES8311", first[0])
        self.assertIn(b"authmode == WIFI_AUTH_OPEN", first[1])
        for path in paths:
            self.assertEqual(originals[path], (sdk / path).read_bytes())

    def test_device_patch_unknown_bringup_fails_closed(self):
        path = self.root / "boards/xtensa/esp32s3/esp32s3-devkit/src/esp32s3_bringup.c"
        path.parent.mkdir(parents=True)
        path.write_text("unexpected SDK version")
        with self.assertRaisesRegex(ValueError, "版本不匹配"):
            runner.apply_board_device_patches(self.root)

    def test_board_overlay_is_hashed_and_copied_into_snapshot(self):
        overlay = self.root / "boards/xtensa/esp32s3/esp32s3-devkit/src"
        overlay.mkdir(parents=True)
        (overlay / "pixelbox_board.c").write_text("board source")
        (overlay / "nested").mkdir()
        (overlay / "nested/Make.defs").write_text("board make")
        board, summary = runner.board_overlay(self.root, "esp32s3", "esp32s3-devkit:nsh")
        self.assertEqual(board, overlay.parent)
        self.assertEqual(summary["files"], 2)
        self.assertEqual(summary["entries"], ["src/nested/Make.defs", "src/pixelbox_board.c"])
        self.assertEqual(len(summary["sha256"]), 64)
        tree = self.root / "build/esp32s3/nuttx"
        runner.apply_board_overlay(tree, "esp32s3", board)
        self.assertEqual((tree / "boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_board.c").read_text(), "board source")
        self.assertEqual((tree / "boards/xtensa/esp32s3/esp32s3-devkit/src/nested/Make.defs").read_text(), "board make")

    def test_board_overlay_rejects_symlinks(self):
        overlay = self.root / "boards/xtensa/esp32s3/esp32s3-devkit/src"
        overlay.mkdir(parents=True)
        outside = self.root / "outside.c"
        outside.write_text("outside")
        (overlay / "pixelbox_board.c").symlink_to(outside)
        board, _ = runner.board_overlay(self.root, "esp32s3", "esp32s3-devkit:nsh")
        with self.assertRaisesRegex(ValueError, "不允许符号链接"):
            runner.apply_board_overlay(self.root / "build/esp32s3/nuttx", "esp32s3", board)
        self.assertFalse((self.root / "build/esp32s3/nuttx/boards/xtensa/esp32s3/esp32s3-devkit/src/pixelbox_board.c").exists())

    def test_source_filter_keeps_nested_nuttx_port_directories(self):
        (self.root / "nuttx").mkdir()
        self.assertNotIn("nuttx", runner.ignored(str(self.root), ["nuttx", ".git", "old.o"]))
        self.assertIn(".git", runner.ignored(str(self.root), ["nuttx", ".git", "old.o"]))

    def source_trees(self):
        kernel = self.root / "sdk/nuttx"
        apps = self.root / "sdk/apps"
        kernel.mkdir(parents=True)
        apps.mkdir()
        return kernel, apps, self.root / "build/nuttx", self.root / "build/apps"

    def test_source_links_stay_inside_snapshot_including_cross_tree_links(self):
        kernel, apps, tree, app_tree = self.source_trees()
        (kernel / "source").mkdir()
        (kernel / "source/main.c").write_text("kernel")
        (apps / "shared.h").write_text("apps")
        (kernel / "absolute").symlink_to(kernel / "source")
        (kernel / "relative").symlink_to("source/main.c")
        (kernel / "cross.h").symlink_to(apps / "shared.h")
        (apps / "kernel.c").symlink_to("../nuttx/source/main.c")
        runner.copy_sources(kernel, apps, tree, app_tree)
        self.assertEqual((tree / "absolute").resolve(), tree / "source")
        self.assertEqual((tree / "relative").resolve(), tree / "source/main.c")
        self.assertEqual((tree / "cross.h").resolve(), app_tree / "shared.h")
        self.assertEqual((app_tree / "kernel.c").resolve(), tree / "source/main.c")
        self.assertFalse(os.path.isabs(os.readlink(tree / "absolute")))
        (tree / "absolute/main.c").write_text("snapshot only")
        self.assertEqual((kernel / "source/main.c").read_text(), "kernel")

    def test_archive_apps_alias_maps_to_selected_apps_snapshot(self):
        kernel, apps, tree, app_tree = self.source_trees()
        renamed_apps = apps.with_name("nuttx-apps-nuttx-12.9.0")
        apps.rename(renamed_apps)
        (renamed_apps / "system/zlib").mkdir(parents=True)
        (renamed_apps / "system/zlib/zlib.h").write_text("selected apps")
        (kernel / "fs/zipfs").mkdir(parents=True)
        (kernel / "fs/zipfs/zlib").symlink_to("../../../apps/system/zlib")
        self.assertFalse(apps.exists())
        runner.copy_sources(kernel, renamed_apps, tree, app_tree)
        link = tree / "fs/zipfs/zlib"
        self.assertEqual(link.resolve(), app_tree / "system/zlib")
        self.assertEqual((link / "zlib.h").read_text(), "selected apps")
        self.assertFalse(os.path.isabs(os.readlink(link)))

    def test_apps_alias_does_not_allow_absolute_or_escaping_external_links(self):
        kernel, apps, tree, app_tree = self.source_trees()
        renamed_apps = apps.with_name("nuttx-apps-nuttx-12.9.0")
        apps.rename(renamed_apps)
        (kernel / "fs/zipfs").mkdir(parents=True)
        link = kernel / "fs/zipfs/unsafe"
        for target in (str(apps / "system/zlib"), "../../../apps/../../private.h"):
            with self.subTest(target=target):
                link.symlink_to(target)
                with self.assertRaisesRegex(ValueError, "源码树外"):
                    runner.copy_sources(kernel, renamed_apps, tree, app_tree)
                self.assertFalse(os.path.lexists(tree / "fs/zipfs/unsafe"))
                link.unlink()

    def test_source_copy_drops_old_configuration_links_and_dependency_state(self):
        kernel, apps, tree, app_tree = self.source_trees()
        (kernel / "arch/xtensa/src").mkdir(parents=True)
        (kernel / "include").mkdir()
        (kernel / "boards/old/src").mkdir(parents=True)
        (kernel / "arch/xtensa/src/board").symlink_to(kernel / "boards/old/src")
        (kernel / "include/arch").symlink_to(kernel / "arch/xtensa")
        (kernel / "Make.defs").symlink_to(kernel / "boards/old/Make.defs")
        for name in (".dirlinks", ".depend", ".built", "Make.dep"):
            (kernel / name).write_text("old configuration")
        runner.copy_sources(kernel, apps, tree, app_tree)
        for name in ("arch/xtensa/src/board", "include/arch", "Make.defs",
                     ".dirlinks", ".depend", ".built", "Make.dep"):
            self.assertFalse(os.path.lexists(tree / name), name)
        self.assertTrue((tree / "boards/old/src").is_dir())

    def test_source_copy_rejects_external_and_looping_links(self):
        kernel, apps, tree, app_tree = self.source_trees()
        outside = self.root / "private.h"
        outside.write_text("untouched")
        link = kernel / "unsafe.h"
        link.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "源码树外"):
            runner.copy_sources(kernel, apps, tree, app_tree)
        self.assertFalse(os.path.lexists(tree / "unsafe.h"))
        self.assertEqual(outside.read_text(), "untouched")
        link.unlink()
        link.symlink_to("unsafe.h")
        with self.assertRaisesRegex(ValueError, "循环"):
            runner.copy_sources(kernel, apps, tree, app_tree)

    def test_interrupted_source_copy_retries_existing_files_and_links(self):
        kernel, apps, tree, app_tree = self.source_trees()
        (kernel / "a-link").symlink_to("b.c")
        (kernel / "b.c").write_text("complete file")
        (apps / "header.h").write_text("apps")

        def interrupt_copy(source, destination, **kwargs):
            Path(destination).write_text("partial")
            raise KeyboardInterrupt("simulated cancellation")

        with mock.patch.object(runner.shutil, "copy2", side_effect=interrupt_copy):
            with self.assertRaises(KeyboardInterrupt):
                runner.copy_sources(kernel, apps, tree, app_tree)
        self.assertTrue((tree / "a-link").is_symlink())
        runner.copy_sources(kernel, apps, tree, app_tree)
        self.assertEqual((tree / "a-link").read_text(), "complete file")
        self.assertEqual((app_tree / "header.h").read_text(), "apps")

    def test_source_copy_does_not_follow_existing_destination_links(self):
        kernel, apps, tree, app_tree = self.source_trees()
        (kernel / "src").mkdir()
        (kernel / "src/main.c").write_text("new source")
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "main.c").write_text("untouched")
        tree.mkdir(parents=True)
        (tree / "src").symlink_to(outside)
        runner.copy_sources(kernel, apps, tree, app_tree)
        self.assertFalse((tree / "src").is_symlink())
        self.assertEqual((tree / "src/main.c").read_text(), "new source")
        self.assertEqual((outside / "main.c").read_text(), "untouched")

    def test_source_retry_removes_links_absent_from_current_sdk(self):
        kernel, apps, tree, app_tree = self.source_trees()
        tree.mkdir(parents=True)
        (tree / "old-sdk").symlink_to(kernel)
        (tree / "old-file.c").write_text("partial previous snapshot")
        (kernel / "main.c").write_text("current source")
        runner.copy_sources(kernel, apps, tree, app_tree)
        self.assertFalse(os.path.lexists(tree / "old-sdk"))
        self.assertFalse((tree / "old-file.c").exists())
        self.assertEqual((kernel / "main.c").read_text(), "current source")

    def _offline_hal_tree(self):
        """创建可验证 HAL 物化和 Make.defs 改写的最小快照。"""
        tree = self.root / "build/esp32s3/nuttx"
        hal = tree / runner.ESP_HAL_REPO_RELATIVE
        mbedtls = hal / "components/mbedtls/mbedtls"
        patches = hal / "nuttx/patches/components/mbedtls/mbedtls"
        mbedtls.mkdir(parents=True)
        patches.mkdir(parents=True)
        (mbedtls / "version.txt").write_text("before\n")
        (patches / "0001-test.patch").write_text(
            "--- a/version.txt\n+++ b/version.txt\n@@ -1 +1 @@\n-before\n+after\n")
        make_defs = tree / "arch/xtensa/src/esp32s3/Make.defs"
        make_defs.parent.mkdir(parents=True, exist_ok=True)
        make_defs.write_text(
            "context:: chip/$(ESP_HAL_3RDPARTY_REPO)\n"
            "ifeq ($(CONFIG_ESPRESSIF_WIRELESS),y)\n"
            "\t$(Q) git -C chip/$(ESP_HAL_3RDPARTY_REPO) submodule --quiet update --init\n"
            "\t$(Q) git apply ../../../nuttx/patches/components/mbedtls/mbedtls/*.patch\n"
            "endif\n\n"
            "distclean::\n")
        return tree, hal

    def test_offline_hal_materializes_checked_library_and_patches(self):
        tree, hal = self._offline_hal_tree()
        dependency = self.root / "third_party" / runner.ESP_HAL_DEPENDENCY_ROOT / "components/esp_wifi/lib/esp32s3"
        dependency.mkdir(parents=True)
        source = dependency / "libcore.a"
        source.write_bytes(b"controlled library")
        digest = runner.hashlib.sha256(source.read_bytes()).hexdigest()
        with mock.patch.object(runner, "ESP_HAL_LIBRARY_SHA256",
                               {"components/esp_wifi/lib/esp32s3/libcore.a": digest}), \
             mock.patch.object(runner, "ESP_HAL_HEADER_SHA256", {}):
            self.assertTrue(runner._materialize_esp_hal(self.root, tree))
        self.assertEqual((hal / "components/esp_wifi/lib/esp32s3/libcore.a").read_bytes(),
                         b"controlled library")
        self.assertEqual((hal / "components/mbedtls/mbedtls/version.txt").read_text(), "after\n")
        self.assertTrue((hal / runner.ESP_HAL_OFFLINE_MARKER).is_file())
        make_defs = (tree / "arch/xtensa/src/esp32s3/Make.defs").read_text()
        self.assertIn("NUTTX_ESP_HAL_OFFLINE", make_defs)
        self.assertIn("Using offline ESP HAL dependencies", make_defs)

    def test_offline_hal_rejects_missing_checked_library(self):
        tree, _ = self._offline_hal_tree()
        dependency = self.root / "third_party" / runner.ESP_HAL_DEPENDENCY_ROOT
        dependency.mkdir(parents=True)
        with mock.patch.object(runner, "ESP_HAL_LIBRARY_SHA256",
                               {"components/esp_wifi/lib/esp32s3/libcore.a": "0" * 64}), \
             mock.patch.object(runner, "ESP_HAL_HEADER_SHA256", {}):
            with self.assertRaisesRegex(ValueError, "缺少 ESP32-S3 无线库"):
                runner._materialize_esp_hal(self.root, tree)

    def test_offline_hal_rejects_wrong_headers_before_copying_libraries(self):
        tree, hal = self._offline_hal_tree()
        header = hal / "wifi_abi.h"
        header.write_text("wrong ABI")
        with mock.patch.object(runner, "ESP_HAL_HEADER_SHA256", {"wifi_abi.h": "0" * 64}):
            with self.assertRaisesRegex(ValueError, "头文件 ABI 不匹配"):
                runner._materialize_esp_hal(self.root, tree)
        self.assertFalse((hal / "components/esp_wifi/lib").exists())

    def test_prepare_offline_dependencies_skips_hal_for_lightweight_tree(self):
        tree = self.root / "build/esp32s3/nuttx"
        tree.mkdir(parents=True)
        runner.prepare_offline_dependencies(self.root, tree)
        self.assertFalse((tree / runner.OFFLINE_DEPS_FILE).exists())

    def test_ble_private_dependencies_precede_first_configure(self):
        kernel, apps, _, _ = self.source_trees()
        (kernel / "main.c").write_text("kernel remains unchanged")
        (self.root / "configs").mkdir()
        (self.root / "configs/esp32s3.config").write_text(
            self.valid_config() + "CONFIG_NIMBLE=y\n" + "".join(
                f"{key}=y\n" for key in (
                    "CONFIG_ALLOW_BSD_COMPONENTS", "CONFIG_WIRELESS",
                    "CONFIG_WIRELESS_BLUETOOTH", "CONFIG_NET_BLUETOOTH",
                    "CONFIG_DRIVERS_BLUETOOTH", "CONFIG_ESPRESSIF_BLE",
                    "CONFIG_NETDEV_IFINDEX", "CONFIG_NETDEV_IOCTL")))
        for name in ("Makefile", "Make.defs", "Kconfig"):
            (self.root / name).write_text("template")
        commands = []

        def fake_run(arguments, cwd, env):
            commands.append(arguments)
            if arguments[:2] == ["bash", "tools/configure.sh"]:
                (cwd / ".config").write_text(self.valid_config())
                (cwd / ".config.orig").write_text(self.valid_config())

        with mock.patch.object(runner, "run", side_effect=fake_run):
            tree = runner.prepare(self.root, kernel, apps, "esp32s3",
                                  "esp32s3-devkit:nsh", "make", {})
        ble = next(i for i, args in enumerate(commands)
                   if len(args) > 1 and args[1].endswith("prepare_ble.py"))
        ble_tx = next(i for i, args in enumerate(commands)
                      if len(args) > 1 and args[1].endswith("prepare_ble_tx.py"))
        configure = next(i for i, args in enumerate(commands)
                         if args[:2] == ["bash", "tools/configure.sh"])
        self.assertLess(ble, configure)
        self.assertLess(ble, ble_tx)
        self.assertLess(ble_tx, configure)
        self.assertEqual(commands[ble_tx][2:], [str(self.root), str(tree)])
        self.assertEqual(commands[ble][2:], [str(self.root), str(tree),
                         str(self.root / "build/esp32s3/apps")])
        self.assertEqual((kernel / "main.c").read_text(), "kernel remains unchanged")

    def test_prepare_interruption_does_not_mark_snapshot_ready_and_can_retry(self):
        kernel, apps, _, _ = self.source_trees()
        (kernel / "main.c").write_text("kernel")
        (self.root / "configs").mkdir()
        (self.root / "configs/esp32s3.config").write_text(self.valid_config())
        for name in ("Makefile", "Make.defs", "Kconfig"):
            (self.root / name).write_text("template")
        build = self.root / "build/esp32s3"
        with mock.patch.object(runner.shutil, "copy2", side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
        self.assertTrue((build / runner.STATE_FILE).is_file())
        self.assertFalse((build / ".sources-ready").exists())
        self.assertFalse((build / ".configured").exists())

        def fake_run(arguments, cwd, env):
            if arguments[:2] == ["bash", "tools/configure.sh"]:
                (cwd / ".config").write_text(self.valid_config())
                (cwd / ".config.orig").write_text(self.valid_config())

        with mock.patch.object(runner, "run", side_effect=fake_run):
            tree = runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
        self.assertEqual((tree / "main.c").read_text(), "kernel")
        self.assertTrue((build / ".sources-ready").is_file())
        self.assertTrue((build / ".configured").is_file())
        with mock.patch.object(runner, "run"), \
                mock.patch.object(runner, "copy_sources", side_effect=AssertionError("snapshot copied twice")), \
                mock.patch.object(sys, "stdout", new_callable=io.StringIO) as output:
            runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
        self.assertIn("同路径更新，请先运行 clean", output.getvalue())

    def test_existing_board_source_changes_refresh_without_losing_build_artifacts(self):
        kernel, apps, tree, _ = self.source_trees()
        (self.root / "configs").mkdir()
        (self.root / "configs/esp32s3.config").write_text(self.valid_config())
        board = self.root / "boards/xtensa/esp32s3/esp32s3-devkit/src"
        board.mkdir(parents=True)
        source = board / "display.c"
        source.write_text("old driver")
        for name in ("Makefile", "Make.defs", "Kconfig"):
            (self.root / name).write_text("template")
        def fake_run(arguments, cwd, env):
            if arguments[:2] == ["bash", "tools/configure.sh"]:
                (cwd / ".config").write_text(self.valid_config())
                (cwd / ".config.orig").write_text(self.valid_config())
        with mock.patch.object(runner, "run", side_effect=fake_run):
            tree = runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
        artifact = tree / "nuttx.bin"
        artifact.write_bytes(b"previous image")
        source.write_text("fixed driver")
        with mock.patch.object(runner, "run"), mock.patch.object(runner, "copy_sources", side_effect=AssertionError("unexpected recopy")):
            runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
        self.assertEqual((tree / "boards/xtensa/esp32s3/esp32s3-devkit/src/display.c").read_text(), "fixed driver")
        self.assertEqual(artifact.read_bytes(), b"previous image")
        (board / "new.c").write_text("new source")
        with self.assertRaisesRegex(ValueError, "构建来源或配置已改变"):
            runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})

    def test_application_sources_link_individually_and_objects_stay_in_build(self):
        project = self.root / "project"
        (project / "src").mkdir(parents=True)
        (project / "src/main.c").write_text("int main(void) { return 0; }")
        (project / "src/portal_html.inc").write_text('"embedded portal"')
        for name in ("Makefile", "Make.defs", "Kconfig"):
            (project / name).write_text(name)
        application = project / "build/apps/interpreters/pixelbox"
        runner.stage_application(project, application)
        self.assertFalse((application / "src").is_symlink())
        self.assertTrue((application / "src/main.c").is_symlink())
        self.assertEqual((application / "src/portal_html.inc").read_text(), '"embedded portal"')
        (application / "src/main.o").write_bytes(b"object")
        self.assertFalse((project / "src/main.o").exists())
        runner.stage_application(project, application)
        self.assertEqual((application / "src/main.o").read_bytes(), b"object")

    def test_portal_patches_are_opt_in_and_only_touch_private_snapshot(self):
        project = Path(__file__).resolve().parents[1]
        sources = ((project.parent / ".deps/nuttx", "arch/xtensa/src/esp32s3/esp32s3_wifi_adapter.c"),
                   (project.parent / ".deps/apps", "netutils/dhcpd/dhcpd.c"))
        if not all((sdk / relative).is_file() for sdk, relative in sources):
            self.skipTest("local NuttX SDK is unavailable")
        trees = (self.root / "nuttx", self.root / "apps")
        originals = []
        for (sdk, relative), tree in zip(sources, trees):
            original = (sdk / relative).read_bytes()
            originals.append(original)
            target = tree / relative
            target.parent.mkdir(parents=True)
            target.write_bytes(original)
        runner.apply_portal_patches(project, *trees, False, dict(os.environ))
        self.assertEqual(originals, [(tree / relative).read_bytes()
                                    for tree, (_, relative) in zip(trees, sources)])
        runner.apply_portal_patches(project, *trees, True, dict(os.environ))
        patched = [(tree / relative).read_bytes() for tree, (_, relative) in zip(trees, sources)]
        self.assertIn(b"pixelbox_wifi_apsta_safe", patched[0])
        self.assertIn(b"pixelbox_dhcpd_safe", patched[1])
        runner.apply_portal_patches(project, *trees, True, dict(os.environ))
        self.assertEqual(patched, [(tree / relative).read_bytes()
                                  for tree, (_, relative) in zip(trees, sources)])
        self.assertEqual(originals, [(sdk / relative).read_bytes() for sdk, relative in sources])

    def multinet_config(self):
        return self.valid_config() + "".join(f"{key}=y\n" for key in (
            "CONFIG_INTERPRETERS_PIXELBOX_MULTINET7", "CONFIG_ARCH_CHIP_ESP32S3",
            "CONFIG_ESP32S3_SPIRAM", "CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP",
            "CONFIG_ARCH_SETJMP_H")) + "CONFIG_XTENSA_CP_INITSET=0x0009\n"

    def test_multinet_requires_exact_abi_and_surviving_enable(self):
        config = self.root / ".config"
        complete = self.multinet_config()
        config.write_text(complete)
        runner.validate_config(config, multinet_requested=True)
        for key in ("CONFIG_ARCH_CHIP_ESP32S3", "CONFIG_ESP32S3_SPIRAM",
                    "CONFIG_XTENSA_IMEM_USE_SEPARATE_HEAP", "CONFIG_ARCH_SETJMP_H"):
            with self.subTest(key=key):
                config.write_text(complete.replace(f"{key}=y\n", ""))
                with self.assertRaisesRegex(ValueError, key):
                    runner.validate_config(config)
        for value in ("0x0001", "0x0008", "0x000b", "invalid", ""):
            with self.subTest(cp_initset=value):
                config.write_text(complete.replace("0x0009", value))
                with self.assertRaisesRegex(ValueError, "CONFIG_XTENSA_CP_INITSET"):
                    runner.validate_config(config)
        config.write_text(complete.replace("0x0009", "9"))
        runner.validate_config(config)
        config.write_text(self.valid_config())
        with self.assertRaisesRegex(ValueError, "MULTINET7=y 未生效"):
            runner.validate_config(config, multinet_requested=True)

    def test_multinet_profile_inherits_board_and_stages_only_audited_object(self):
        kernel, apps, _, _ = self.source_trees()
        (self.root / "configs").mkdir()
        base = self.multinet_config().replace("CONFIG_INTERPRETERS_PIXELBOX_MULTINET7=y\n", "")
        (self.root / "configs/esp32s3.config").write_text(base)
        (self.root / "configs/esp32s3-multinet7.config").write_text("CONFIG_INTERPRETERS_PIXELBOX_MULTINET7=y\n")
        board = self.root / "boards/xtensa/esp32s3/esp32s3-devkit/src"
        board.mkdir(parents=True)
        (board / "display.c").write_text("real board source")
        for name in ("Makefile", "Make.defs", "Kconfig"):
            (self.root / name).write_text("template")
        commands = []
        drop_multinet = False

        def fake_run(arguments, cwd, env):
            commands.append(arguments)
            if len(arguments) > 1 and arguments[1].endswith("prepare_wakeword.py"):
                generated = self.root / "generated/wakeword"
                generated.mkdir(parents=True, exist_ok=True)
                for name in ("multinet7.o", "model.S", "srmodels.bin", "manifest.json", "cJSON.c"):
                    (generated / name).write_text("audited fixture " + name)
                (generated / "stale.o").write_text("must not be staged")
            if arguments[:2] == ["bash", "tools/configure.sh"]:
                application = self.root / "build/esp32s3-multinet7/apps/interpreters/pixelbox"
                self.assertTrue((application / "generated/wakeword/multinet7.o").is_symlink())
                self.assertFalse((application / "generated/wakeword/stale.o").exists())
                (cwd / ".config").write_text(self.valid_config())
                (cwd / ".config.orig").write_text(self.valid_config())
            if arguments == ["make", "olddefconfig"] and drop_multinet:
                (cwd / ".config").write_text(base)

        with mock.patch.object(runner, "run", side_effect=fake_run), \
                mock.patch.object(runner, "discover_toolchain", return_value=(self.root / "toolchain", "xtensa-esp32s3-elf-gcc")):
            # 缺少 Kconfig 依赖导致请求被丢弃时，不得留下已配置标记。
            drop_multinet = True
            with self.assertRaisesRegex(ValueError, "MULTINET7=y 未生效"):
                runner.prepare(self.root, kernel, apps, "esp32s3-multinet7", "esp32s3-devkit:nsh", "make", {})
            self.assertFalse((self.root / "build/esp32s3-multinet7/.configured").exists())
            drop_multinet = False
            tree = runner.prepare(self.root, kernel, apps, "esp32s3-multinet7", "esp32s3-devkit:nsh", "make", {})
            self.assertEqual((tree / "boards/xtensa/esp32s3/esp32s3-devkit/src/display.c").read_text(), "real board source")
            self.assertFalse((tree / "boards/xtensa/esp32s3-multinet7").exists())
            self.assertFalse((self.root / "build/esp32s3").exists())
            self.assertEqual((self.root / "configs/esp32s3.config").read_text(), base)
            (tree / ".config").write_text(base)
            with self.assertRaisesRegex(ValueError, "MULTINET7=y 未生效"):
                runner.prepare(self.root, kernel, apps, "esp32s3-multinet7", "esp32s3-devkit:nsh", "make", {})
        prepared = next(args for args in commands if len(args) > 1 and args[1].endswith("prepare_wakeword.py"))
        self.assertEqual(prepared[prepared.index("--cc") + 1], str(self.root / "toolchain/xtensa-esp32s3-elf-gcc"))

    def test_multinet_stage_rejects_missing_generated_model(self):
        for name in ("Makefile", "Make.defs", "Kconfig"):
            (self.root / name).write_text("template")
        with self.assertRaisesRegex(ValueError, "缺少已准备的 MultiNet7"):
            runner.stage_application(self.root, self.root / "application", multinet_enabled=True)

    def test_portal_requested_must_survive_first_and_reused_configure(self):
        kernel, apps, _, _ = self.source_trees()
        (self.root / "configs").mkdir()
        profile = (Path(__file__).resolve().parents[1] / "configs/esp32s3-portal.fragment").read_text()
        complete = self.valid_config() + profile + "CONFIG_NETDEV_WIRELESS_IOCTL=y\n"
        (self.root / "configs/esp32s3.config").write_text(complete)
        for name in ("Makefile", "Make.defs", "Kconfig"):
            (self.root / name).write_text("template")
        commands = []
        drop_portal = True

        def fake_run(arguments, cwd, env):
            commands.append(arguments)
            if arguments[:2] == ["bash", "tools/configure.sh"]:
                (cwd / ".config").write_text(self.valid_config())
                (cwd / ".config.orig").write_text(self.valid_config())
            if arguments == ["make", "olddefconfig"] and drop_portal:
                (cwd / ".config").write_text(complete.replace(
                    "CONFIG_INTERPRETERS_PIXELBOX_PORTAL=y", "# CONFIG_INTERPRETERS_PIXELBOX_PORTAL is not set"))

        with mock.patch.object(runner, "run", side_effect=fake_run):
            with self.assertRaisesRegex(ValueError, "PORTAL=y 未生效"):
                runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
            self.assertFalse((self.root / "build/esp32s3/.configured").exists())
            drop_portal = False
            tree = runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
            (tree / ".config").write_text(self.valid_config())
            with self.assertRaisesRegex(ValueError, "PORTAL=y 未生效"):
                runner.prepare(self.root, kernel, apps, "esp32s3", "esp32s3-devkit:nsh", "make", {})
        configure = next(i for i, args in enumerate(commands) if args[:2] == ["bash", "tools/configure.sh"])
        for script in ("softap_adapter_patch.py", "portal_dhcp_patch.py"):
            patch = next(i for i, args in enumerate(commands) if len(args) > 1 and args[1].endswith(script))
            self.assertLess(patch, configure)
            self.assertTrue(Path(commands[patch][2]).is_relative_to(self.root / "build/esp32s3"))

    def test_portal_requires_effective_dependencies_and_matching_dhcp_pool(self):
        config = self.root / ".config"
        profile = (Path(__file__).resolve().parents[1] / "configs/esp32s3-portal.fragment").read_text()
        complete = self.valid_config() + profile + "CONFIG_NETDEV_WIRELESS_IOCTL=y\n"
        config.write_text(complete)
        runner.validate_config(config, portal_requested=True)
        keys = ("CONFIG_ESPRESSIF_WIFI_STATION_SOFTAP", "CONFIG_NETDEV_WIRELESS_IOCTL",
                "CONFIG_NETUTILS_DHCPD", "CONFIG_NET_BINDTODEVICE",
                "CONFIG_NETUTILS_DHCPD_STARTIP", "CONFIG_NETUTILS_DHCPD_NETMASK",
                "CONFIG_NETUTILS_DHCPD_ROUTERIP", "CONFIG_NETUTILS_DHCPD_DNSIP",
                "CONFIG_NETUTILS_DHCPD_MAXLEASES")
        for key in keys:
            value = runner.parse_config(complete)[key]
            for replacement in ("", f"{key}=invalid\n"):
                with self.subTest(key=key, replacement=replacement):
                    config.write_text(complete.replace(f"{key}={value}\n", replacement))
                    with self.assertRaisesRegex(ValueError, key):
                        runner.validate_config(config)
        config.write_text(complete.replace("CONFIG_NETUTILS_DHCPD_DNSIP=0x0", "CONFIG_NETUTILS_DHCPD_DNSIP=0x08080808"))
        with self.assertRaisesRegex(ValueError, "CONFIG_NETUTILS_DHCPD_DNSIP"):
            runner.validate_config(config)

    def test_config_rejects_idf_bootloader_even_when_simple_is_set(self):
        config = self.root / ".config"
        config.write_text(self.valid_config())
        runner.validate_config(config)
        config.write_text(self.valid_config() + "CONFIG_ESP32S3_APP_FORMAT_LEGACY=y\n")
        with self.assertRaisesRegex(ValueError, "Simple Boot"):
            runner.validate_config(config)

    def test_config_rejects_runtime_removed_by_kconfig(self):
        config = self.root / ".config"
        config.write_text(self.valid_config().replace("CONFIG_INTERPRETERS_PIXELBOX=y", ""))
        with self.assertRaisesRegex(ValueError, "INTERPRETERS_PIXELBOX"):
            runner.validate_config(config)

    def test_wifi_requires_recursive_mutex_support(self):
        config = self.root / ".config"
        base = self.valid_config() + "CONFIG_ESPRESSIF_WIFI=y\n"
        config.write_text(base)
        with self.assertRaisesRegex(ValueError, "PTHREAD_MUTEX_TYPES"):
            runner.validate_config(config)
        config.write_text(base + "CONFIG_PTHREAD_MUTEX_TYPES=y\n")
        runner.validate_config(config)

    def test_event_loop_network_requires_backlog_and_buffered_writes(self):
        config = self.root / ".config"
        base = self.valid_config() + "CONFIG_NET_TCP=y\n"
        config.write_text(base)
        with self.assertRaisesRegex(ValueError, "CONFIG_NET_TCPBACKLOG"):
            runner.validate_config(config)
        config.write_text(base + "CONFIG_NET_TCPBACKLOG=y\n")
        with self.assertRaisesRegex(ValueError, "CONFIG_NET_TCP_WRITE_BUFFERS"):
            runner.validate_config(config)
        config.write_text(base + "CONFIG_NET_TCPBACKLOG=y\nCONFIG_NET_TCP_WRITE_BUFFERS=y\n")
        runner.validate_config(config)

    def test_nimble_requires_effective_raw_hci_config(self):
        config = self.root / ".config"
        keys = ("CONFIG_ALLOW_BSD_COMPONENTS", "CONFIG_WIRELESS",
                "CONFIG_WIRELESS_BLUETOOTH", "CONFIG_NET_BLUETOOTH",
                "CONFIG_DRIVERS_BLUETOOTH", "CONFIG_ESPRESSIF_BLE",
                "CONFIG_NETDEV_IFINDEX", "CONFIG_NETDEV_IOCTL")
        base = self.valid_config() + "CONFIG_NIMBLE=y\n"
        complete = base + "".join(f"{key}=y\n" for key in keys)
        for key in keys:
            with self.subTest(key=key):
                config.write_text(complete.replace(f"{key}=y\n", ""))
                with self.assertRaisesRegex(ValueError, key):
                    runner.validate_config(config)
        config.write_text(complete + "CONFIG_WIRELESS_BLUETOOTH_HOST=y\n")
        with self.assertRaisesRegex(ValueError, "WIRELESS_BLUETOOTH_HOST"):
            runner.validate_config(config)
        config.write_text(complete + "# CONFIG_WIRELESS_BLUETOOTH_HOST is not set\n")
        runner.validate_config(config)

    def test_config_requires_fixed_board_flash_and_storage_layout(self):
        config = self.root / ".config"
        for key, expected, invalid_values in (
                ("CONFIG_ESP32S3_FLASH_16M", "y", (None, "n")),
                ("CONFIG_ESP32S3_STORAGE_MTD_OFFSET", "0x800000",
                 (None, "0x1000000", "0x400000", "-1", "invalid")),
                ("CONFIG_ESP32S3_STORAGE_MTD_SIZE", "0x800000",
                 (None, "0", "0x1000000", "-1", "invalid"))):
            for value in invalid_values:
                with self.subTest(key=key, value=value):
                    replacement = "" if value is None else f"{key}={value}\n"
                    config.write_text(self.valid_config().replace(f"{key}={expected}\n", replacement))
                    with self.assertRaisesRegex(ValueError, key):
                        runner.validate_config(config)
        config.write_text(self.valid_config().replace("0x800000", "8388608"))
        runner.validate_config(config)

    def test_config_rejects_whole_flash_merge_modes(self):
        config = self.root / ".config"
        for key in ("CONFIG_ESPRESSIF_MERGE_BINS", "CONFIG_ESP32S3_MERGE_BINS",
                    "CONFIG_ESP32S3_QEMU_IMAGE"):
            with self.subTest(key=key):
                config.write_text(self.valid_config() + f"{key}=y\n")
                with self.assertRaisesRegex(ValueError, key):
                    runner.validate_config(config)

    def test_clean_preserves_unowned_directory(self):
        build = self.root / "build/esp32s3"
        build.mkdir(parents=True)
        file = build / "important.c"
        file.write_text("user data")
        with self.assertRaisesRegex(ValueError, "构建标记"):
            runner.clean(self.root, "esp32s3")
        self.assertEqual(file.read_text(), "user data")

    def test_clean_rejects_symlink_outside_project(self):
        outside = self.root / "outside"
        outside.mkdir()
        (self.root / "build").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "符号链接"):
            runner.clean(self.root, "esp32s3")
        self.assertTrue(outside.is_dir())

    def test_clean_only_removes_owned_target(self):
        build = self.root / "build/esp32s3"
        build.mkdir(parents=True)
        (build / runner.STATE_FILE).write_text(json.dumps({"project": str(self.root), "target": "esp32s3"}))
        other = self.root / "build/host"
        other.mkdir()
        runner.clean(self.root, "esp32s3")
        self.assertFalse(build.exists())
        self.assertTrue(other.exists())

    def test_interrupted_clean_keeps_owner_marker_for_retry(self):
        build = self.root / "build/esp32s3"
        for name in ("apps", "nuttx"):
            (build / name).mkdir(parents=True)
            (build / name / "object.o").write_text("object")
        marker = build / runner.STATE_FILE
        marker.write_text(json.dumps({"project": str(self.root), "target": "esp32s3"}))
        (build / ".sources-ready").touch()
        (build / ".configured").touch()
        rmtree = runner.shutil.rmtree

        def interrupt_cleanup(path, **kwargs):
            rmtree(path, **kwargs)
            raise KeyboardInterrupt("simulated cancellation")

        with mock.patch.object(runner.shutil, "rmtree", side_effect=interrupt_cleanup):
            with self.assertRaises(KeyboardInterrupt):
                runner.clean(self.root, "esp32s3")
        self.assertTrue(marker.is_file())
        self.assertTrue(build.exists())
        self.assertFalse((build / ".sources-ready").exists())
        self.assertFalse((build / ".configured").exists())
        runner.clean(self.root, "esp32s3")
        self.assertFalse(build.exists())

    def test_clean_recovers_empty_directory_after_marker_removal(self):
        build = self.root / "build/esp32s3"
        build.mkdir(parents=True)
        runner.clean(self.root, "esp32s3")
        self.assertFalse(build.exists())

    def test_clean_unlinks_nested_links_without_removing_their_target(self):
        build = self.root / "build/esp32s3"
        build.mkdir(parents=True)
        (build / runner.STATE_FILE).write_text(json.dumps({"project": str(self.root), "target": "esp32s3"}))
        outside = self.root / "outside"
        outside.mkdir()
        (outside / "important.c").write_text("untouched")
        (build / "external").symlink_to(outside)
        runner.clean(self.root, "esp32s3")
        self.assertFalse(build.exists())
        self.assertEqual((outside / "important.c").read_text(), "untouched")

    def test_make_paths_reject_colon_before_toolchain_detection(self):
        with mock.patch.object(runner, "ROOT", self.root / "project:unsafe"), \
                mock.patch.object(sys, "executable", "/usr/bin/python3"), \
                mock.patch.object(sys, "stderr", new_callable=io.StringIO) as output:
            self.assertEqual(runner.main(["configure"]), 1)
        self.assertIn("路径只能包含", output.getvalue())

    def test_make_paths_accept_homebrew_versioned_python(self):
        with mock.patch.object(runner, "ROOT", self.root), \
                mock.patch.object(sys, "executable", "/opt/homebrew/opt/python@3.14/bin/python3.14"), \
                mock.patch.dict(os.environ, {"NUTTX_PATH": ""}), \
                mock.patch.object(sys, "stderr", new_callable=io.StringIO) as output:
            self.assertEqual(runner.main(["configure"]), 1)
        self.assertIn("请设置 NUTTX_PATH", output.getvalue())

    def test_candidate_bin_dirs_scans_versioned_espressif_toolchains(self):
        toolchain = self.root / ".espressif/tools/xtensa-esp32s3-elf/13.2.0/xtensa-esp32s3-elf/bin"
        toolchain.mkdir(parents=True)
        with mock.patch.dict(os.environ, {"HOME": str(self.root)}, clear=False):
            candidates = runner._candidate_bin_dirs()
        self.assertIn(toolchain, candidates)

    def test_missing_archive_tools_fail_before_preparing_sources(self):
        kernel, apps, _, _ = self.source_trees()
        (kernel / "tools").mkdir()
        (kernel / "tools/configure.sh").write_text("configure")
        (kernel / "Kconfig").write_text("config")
        (apps / "Application.mk").write_text("apps")
        (apps / "interpreters").mkdir()
        (apps / "interpreters/Make.defs").write_text("apps")
        project = self.root / "project"
        project.mkdir()
        (project / "pixelbox.json").write_text(json.dumps({"firmwareBackend": "nuttx"}))
        for missing in ("flock", "git"):
            with self.subTest(missing=missing), \
                    mock.patch.object(runner, "ROOT", project), \
                    mock.patch.object(sys, "executable", "/usr/bin/python3"), \
                    mock.patch.object(runner.shutil, "which", side_effect=lambda tool: None if tool == missing else "/tools/" + tool), \
                    mock.patch.object(runner, "prepare") as prepare, \
                    mock.patch.object(runner, "run") as run, \
                    mock.patch.object(sys, "stderr", new_callable=io.StringIO) as output:
                self.assertEqual(runner.main(["build", "--nuttx-path", str(kernel), "--apps-path", str(apps)]), 1)
                self.assertIn(f"PATH 缺少 {missing}", output.getvalue())
                prepare.assert_not_called()
                run.assert_not_called()
                self.assertFalse((project / "build").exists())
                self.assertFalse((project / ".nuttx-build.lock").exists())

    def fake_heap_toolchain(self, symbol="_sheap B 3fcba064", exit_code=0):
        # 执行真实 checker，只替换 nm 外部程序；产物关联及错误传播仍走真实文件。
        tools = self.root / "heap-toolchain"
        tools.mkdir(exist_ok=True)
        nm = tools / "xtensa-esp32s3-elf-nm"
        nm.write_text(f"#!{sys.executable}\nimport json,pathlib,sys\n"
                      f"pathlib.Path({str(self.root / 'nm-call.json')!r}).write_text(json.dumps(sys.argv[1:]))\n"
                      f"print({symbol!r})\nsys.exit({exit_code})\n")
        nm.chmod(0o755)
        patcher = mock.patch.object(runner, "discover_toolchain", return_value=(tools, "xtensa-esp32s3-elf-gcc"))
        patcher.start()
        self.addCleanup(patcher.stop)
        return tools

    def make_tree(self, size=None, storage="0x800000"):
        self.fake_heap_toolchain()
        tree = self.root / "build/esp32s3/nuttx"
        tree.mkdir(parents=True)
        image = image_tool.add_digest(self.simple_boot_image())
        (tree / "nuttx.bin").write_bytes(image if size is None else image.ljust(size, b"\xff")[:size])
        (tree / "nuttx").write_bytes(b"ELF")
        (tree / ".config").write_text(self.valid_config().replace(
            "CONFIG_ESP32S3_STORAGE_MTD_OFFSET=0x800000",
            f"CONFIG_ESP32S3_STORAGE_MTD_OFFSET={storage}"))
        return tree

    def test_simpleboot_package_exact_bytes_and_offset(self):
        tree = self.make_tree()
        runner.collect(self.root, tree, "esp32s3", True)
        self.assertEqual((self.root / "dist/esp32s3-nuttx.bin").read_bytes(), (tree / "nuttx.bin").read_bytes())
        manifest = json.loads((self.root / "dist/esp32s3-nuttx.json").read_text())
        self.assertEqual(manifest["offset"], "0x0")
        self.assertEqual(manifest["boot"], "simple")
        self.assertEqual((self.root / "build/esp32s3/nuttx.elf").read_bytes(), b"ELF")
        for binary in (tree.parent / "nuttx.bin", self.root / "dist/esp32s3-nuttx.bin"):
            evidence = json.loads(binary.with_suffix(".heap.json").read_text())
            self.assertEqual(evidence["imageSha256"], hashlib.sha256(binary.read_bytes()).hexdigest())
            self.assertEqual(evidence["elfSha256"], hashlib.sha256(binary.with_suffix(".elf").read_bytes()).hexdigest())
            self.assertEqual(evidence["configSha256"], hashlib.sha256(binary.with_suffix(".config").read_bytes()).hexdigest())
            self.assertEqual(evidence["tail_bytes"], 19920)
            self.assertIn("WROOM-1-N16R8", evidence["rom_endpoint_source"])

    def test_internal_heap_uses_target_nm_and_actual_linker_symbol(self):
        tree = self.make_tree()
        report = runner.validate_internal_heap(tree / "nuttx", tree / ".config")
        self.assertTrue(report["pass"])
        self.assertEqual(report["_sheap"], 0x3FCBA064)
        self.assertEqual(report["tail_bytes"], 19920)
        self.assertEqual(json.loads((self.root / "nm-call.json").read_text()),
                         ["--format=posix", str(tree / "nuttx")])

    def test_collect_rejects_real_overlapping_heap_before_publishing(self):
        tree = self.make_tree()
        (tree / ".config").write_text(self.valid_config().replace("0x30000", "0x38000"))
        with self.assertRaisesRegex(ValueError, "-12848"):
            runner.collect(self.root, tree, "esp32s3", True)
        self.assertFalse((tree.parent / "nuttx.bin").exists())
        self.assertFalse((self.root / "dist").exists())

    def test_heap_check_fails_closed_without_elf_symbol_or_tool(self):
        tree = self.make_tree()
        with self.assertRaisesRegex(ValueError, "ELF does not exist"):
            runner.validate_internal_heap(tree / "missing.elf", tree / ".config")
        self.fake_heap_toolchain("other B 3fcba064")
        with self.assertRaisesRegex(ValueError, "found 0"):
            runner.validate_internal_heap(tree / "nuttx", tree / ".config")
        self.fake_heap_toolchain(exit_code=1)
        with self.assertRaisesRegex(ValueError, "内部堆门禁失败"):
            runner.validate_internal_heap(tree / "nuttx", tree / ".config")
        with mock.patch.object(runner, "discover_toolchain", return_value=None):
            with self.assertRaisesRegex(ValueError, "工具链"):
                runner.validate_internal_heap(tree / "nuttx", tree / ".config")
        with mock.patch.object(runner, "discover_toolchain", return_value=(self.root / "missing", "xtensa-esp-elf-gcc")):
            with self.assertRaisesRegex(ValueError, "nm"):
                runner.validate_internal_heap(tree / "nuttx", tree / ".config")

    def test_flash_rejects_stale_or_missing_heap_evidence_before_opening_device(self):
        tree = self.make_tree()
        runner.collect(self.root, tree, "esp32s3", False)
        binary = tree.parent / "nuttx.bin"
        tool, record = self.fake_esptool()
        for suffix in (".elf", ".config", ".heap.json"):
            path = binary.with_suffix(suffix)
            original = path.read_bytes()
            with self.subTest(suffix=suffix):
                path.write_bytes(b"unrelated build")
                with self.assertRaises(ValueError):
                    runner.flash(tree, binary, tool, "/dev/cu.fixture", 115200, dict(os.environ))
                self.assertFalse(record.exists())
                self.assertEqual(list(tree.parent.glob(".pixelbox-flash-*")), [])
            path.write_bytes(original)
        evidence_path = binary.with_suffix(".heap.json")
        evidence = json.loads(evidence_path.read_text())
        evidence["imageSha256"] = "0" * 64
        evidence_path.write_text(json.dumps(evidence))
        with self.assertRaisesRegex(ValueError, "imageSha256"):
            runner.flash(tree, binary, tool, "/dev/cu.fixture", 115200, dict(os.environ))
        self.assertFalse(record.exists())
        orphan = self.root / "orphan.bin"
        orphan.write_bytes(binary.read_bytes())
        with self.assertRaisesRegex(ValueError, "缺少有效"):
            runner.flash(tree, orphan, tool, "/dev/cu.fixture", 115200, dict(os.environ))
        self.assertFalse(record.exists())

    def test_flash_rechecks_heap_even_when_collected_report_claims_pass(self):
        tree = self.make_tree()
        runner.collect(self.root, tree, "esp32s3", False)
        binary = tree.parent / "nuttx.bin"
        tool, record = self.fake_esptool()
        # 元数据中的 pass 不能代替每次烧录前重新读取 ELF 并执行边界判断。
        self.fake_heap_toolchain("_sheap B 3fcbf000")
        with self.assertRaisesRegex(ValueError, "内部堆门禁失败"):
            runner.flash(tree, binary, tool, "/dev/cu.fixture", 115200, dict(os.environ))
        self.assertFalse(record.exists())

    def simple_boot_image(self, padding=80):
        header = bytearray(24)
        header[0:4] = b"\xe9\x02\x02\x40"
        header[12] = 9
        data = header
        checksum = 0xEF
        for address, payload in ((0x3FC90000, b"RAM data"),
                                 (0x40374000, b"RAM code1234")):
            data += struct.pack("<II", address, len(payload)) + payload
            for value in payload:
                checksum ^= value
        data += bytes(15 - len(data) % 16) + bytes([checksum])
        data += struct.pack("<II", 0, padding) + bytes(padding)
        payload = b"Flash code and data"
        data += struct.pack("<II", 0x42000000 + len(data) + 8, len(payload)) + payload
        return bytes(data)

    def test_simpleboot_digest_preserves_ram_flash_offsets_and_contents(self):
        original = self.simple_boot_image()
        end = image_tool.ram_image_end(original)
        patched = image_tool.add_digest(original)
        self.assertEqual(len(patched), len(original))
        self.assertEqual(patched[:23], original[:23])
        self.assertEqual(patched[23], 1)
        self.assertEqual(patched[24:end], original[24:end])
        self.assertEqual(patched[end:end + 32], hashlib.sha256(patched[:end]).digest())
        self.assertEqual(struct.unpack_from("<II", patched, end + 32), (0, 48))
        self.assertEqual(patched[end + 88:], original[end + 88:])
        self.assertEqual(image_tool.add_digest(patched), patched)
        self.assertEqual(image_tool.validate_image(patched), patched[end:end + 32].hex())

    def test_simpleboot_rejects_corrupt_ram_checksum_or_digest(self):
        valid = image_tool.add_digest(self.simple_boot_image())
        end = image_tool.ram_image_end(valid)
        for offset in (32, end - 1, end, 3):
            with self.subTest(offset=offset):
                corrupted = bytearray(valid)
                corrupted[offset] ^= 1
                with self.assertRaisesRegex(ValueError, "checksum|SHA-256"):
                    image_tool.add_digest(bytes(corrupted))

    def test_simpleboot_short_padding_moves_flash_by_one_mmu_page(self):
        for padding in (0, 4, 16, 28):
            with self.subTest(padding=padding):
                original = self.simple_boot_image(padding)
                end = image_tool.ram_image_end(original)
                patched = image_tool.add_digest(original)
                self.assertEqual(len(patched), len(original) + 0x10000)
                self.assertEqual(patched[24:end], original[24:end])
                self.assertEqual(struct.unpack_from("<II", patched, end + 32),
                                 (0, padding + 0x10000 - 32))
                old_flash = end + 8 + padding
                new_flash = old_flash + 0x10000
                self.assertEqual(patched[new_flash:], original[old_flash:])
                address, _ = struct.unpack_from("<II", patched, new_flash)
                self.assertEqual((new_flash + 8) % 0x10000, address % 0x10000)
                self.assertEqual(image_tool.add_digest(patched), patched)
                image_tool.validate_image(patched)

    def test_simpleboot_rejects_missing_or_nonzero_padding_without_writes(self):
        original = bytearray(self.simple_boot_image())
        end = image_tool.ram_image_end(original)
        original[end + 8] = 1
        with self.assertRaisesRegex(ValueError, "非零数据"):
            image_tool.add_digest(bytes(original))
        image = self.root / "corrupt.bin"
        image.write_bytes(original)
        result = subprocess.run([sys.executable, str(IMAGE_SPEC.origin), str(image)],
                                capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(image.read_bytes(), original)

    def test_simpleboot_rejects_truncated_segments_and_wrong_chip(self):
        valid = self.simple_boot_image()
        for data in (valid[:16], valid[:30], valid[:45], valid[:60], valid[:65]):
            with self.subTest(length=len(data)), self.assertRaises(ValueError):
                image_tool.add_digest(data)
        wrong_chip = bytearray(valid)
        wrong_chip[12] = 5
        with self.assertRaisesRegex(ValueError, "芯片"):
            image_tool.add_digest(bytes(wrong_chip))

    def test_simpleboot_collect_only_accepts_already_valid_digest(self):
        tree = self.make_tree()
        binary = tree / "nuttx.bin"
        binary.write_bytes(self.simple_boot_image())
        with (tree / ".config").open("a") as config:
            config.write("CONFIG_ESPRESSIF_SIMPLE_BOOT=y\n")
        with self.assertRaises(subprocess.CalledProcessError):
            runner.collect(self.root, tree, "esp32s3", True)
        self.assertFalse((self.root / "dist").exists())
        binary.write_bytes(image_tool.add_digest(binary.read_bytes()))
        runner.collect(self.root, tree, "esp32s3", True)
        self.assertEqual((self.root / "dist/esp32s3-nuttx.bin").read_bytes(), binary.read_bytes())

    def simple_boot_patch_tree(self):
        tree = self.root / "build/esp32s3/nuttx"
        loader = tree / "arch/xtensa/src/common/espressif/esp_loader.c"
        loader.parent.mkdir(parents=True)
        loader.write_text(
            "          offset += (CHECKSUM_ALIGN - 1) - (offset % CHECKSUM_ALIGN) + 1;\n"
            "          padding_checksum = true;\n")
        makefile = tree / "tools/esp32s3/Config.mk"
        makefile.parent.mkdir(parents=True)
        makefile.write_text(
            "\tesptool.py -c esp32s3 elf2image $(ELF2IMAGE_OPTS) -o nuttx.bin nuttx\n")
        return tree, loader, makefile

    def test_simpleboot_patch_updates_loader_and_every_make_image_generation(self):
        tree, loader, makefile = self.simple_boot_patch_tree()
        runner.apply_simple_boot_digest_patch(tree)
        self.assertIn("if (image_header.hash_appended)", loader.read_text())
        self.assertIn("offset += 32;", loader.read_text())
        self.assertIn("elf2image $(ELF2IMAGE_OPTS) -o nuttx.bin nuttx\n"
                      "\t$(Q) python3 tools/pixelbox_simple_boot_image.py nuttx.bin\n",
                      makefile.read_text())
        staged = tree / "tools/pixelbox_simple_boot_image.py"
        self.assertEqual(staged.read_bytes(), Path(IMAGE_SPEC.origin).read_bytes())
        timestamps = [path.stat().st_mtime_ns for path in (loader, makefile, staged)]
        runner.apply_simple_boot_digest_patch(tree)
        self.assertEqual(timestamps, [path.stat().st_mtime_ns for path in (loader, makefile, staged)])
        image = tree / "nuttx.bin"
        image.write_bytes(self.simple_boot_image())
        subprocess.run([sys.executable, str(staged), str(image)], check=True, timeout=10)
        image_tool.validate_image(image.read_bytes())

    def test_simpleboot_patch_fails_closed_if_upstream_loader_drifted(self):
        tree, loader, makefile = self.simple_boot_patch_tree()
        loader.write_text("different loader\n")
        before = makefile.read_text()
        with self.assertRaisesRegex(ValueError, "loader 版本不匹配"):
            runner.apply_simple_boot_digest_patch(tree)
        self.assertEqual(makefile.read_text(), before)
        self.assertFalse((tree / "tools/pixelbox_simple_boot_image.py").exists())

    def test_image_must_not_overlap_storage(self):
        tree = self.make_tree(size=32, storage="0x10")
        with self.assertRaisesRegex(ValueError, "存储区"):
            runner.collect(self.root, tree, "esp32s3", True)
        self.assertFalse((self.root / "dist").exists())

    def test_image_sector_extent_stops_at_eight_mib(self):
        tree = self.make_tree()
        binary = tree / "nuttx.bin"
        image = binary.read_bytes()
        for size in (0x800000 - 1, 0x800000):
            with self.subTest(size=size):
                binary.write_bytes(image.ljust(size, b"\xff"))
                runner.collect(self.root, tree, "esp32s3", False)
                self.assertEqual((tree.parent / "nuttx.bin").stat().st_size, size)
        for size in (0, 0x800001, 0x1000000):
            with self.subTest(size=size):
                binary.write_bytes(image.ljust(size, b"\xff")[:size])
                with self.assertRaises(ValueError):
                    runner.collect(self.root, tree, "esp32s3", True)
        self.assertFalse((self.root / "dist").exists())

    def fake_esptool(self):
        tool = self.root / "esptool-fixture"
        record = self.root / "esptool-call.json"
        tool.write_text(f"#!{sys.executable}\n"
                        "import hashlib, json, pathlib, sys\n"
                        "image = pathlib.Path(sys.argv[-1]).read_bytes()\n"
                        f"pathlib.Path({str(record)!r}).write_text(json.dumps({{"
                        "'argv': sys.argv[1:], 'size': len(image), "
                        "'sha256': hashlib.sha256(image).hexdigest()}))\n")
        tool.chmod(0o755)
        return tool, record

    def storage_config(self):
        return self.valid_config() + (
            'CONFIG_ESP32S3_SPIFLASH_MTD_BLKSIZE=256\nCONFIG_FS_LITTLEFS=y\n'
            'CONFIG_FS_LITTLEFS_VERSION="v2.5.1"\n'
            'CONFIG_FS_LITTLEFS_READ_SIZE_FACTOR=4\n'
            'CONFIG_FS_LITTLEFS_PROGRAM_SIZE_FACTOR=4\n'
            'CONFIG_FS_LITTLEFS_BLOCK_SIZE_FACTOR=1\n'
            'CONFIG_FS_LITTLEFS_CACHE_SIZE_FACTOR=4\n'
            'CONFIG_FS_LITTLEFS_LOOKAHEAD_SIZE=0\n'
            'CONFIG_FS_LITTLEFS_BLOCK_CYCLE=200\n'
            'CONFIG_FS_LITTLEFS_NAME_MAX=32\n'
            'CONFIG_FS_LITTLEFS_FILE_MAX=2147483647\n'
            'CONFIG_FS_LITTLEFS_ATTR_MAX=1022\n')

    def test_format_flash_uses_real_littlefs_image_only_at_storage_offset(self):
        tree = self.make_tree()
        (tree / ".config").write_text(self.storage_config())
        # 直接使用仓库锁定的上游库，真实执行 format、导出、重新挂载。
        runner._safe_unpack_littlefs(runner.ROOT / "third_party/littlefs-v2.5.1.tar.gz",
                                     tree / "fs/littlefs/littlefs")
        runner.collect(self.root, tree, "esp32s3", False)
        binary = tree.parent / "nuttx.bin"
        tool, record = self.fake_esptool()
        runner.flash(tree, binary, tool, "/dev/cu.fixture", 115200, dict(os.environ),
                     format_storage=True)
        call = json.loads(record.read_text())
        self.assertEqual(call["size"], 0x800000)
        self.assertEqual(call["argv"][-4], "0x0")
        self.assertEqual(call["argv"][-2], "0x800000")
        self.assertNotEqual(call["sha256"], hashlib.sha256(b"\xff" * 0x800000).hexdigest())
        self.assertFalse(Path(call["argv"][-1]).exists())

    def test_format_generation_failure_never_opens_device(self):
        tree = self.make_tree()
        runner.collect(self.root, tree, "esp32s3", False)
        tool, record = self.fake_esptool()
        # 缺少文件系统参数也必须在串口操作前拒绝，不能退化成擦除或普通烧录。
        with self.assertRaisesRegex(ValueError, "LittleFS"):
            runner.flash(tree, tree.parent / "nuttx.bin", tool, "/dev/cu.fixture", 115200,
                         dict(os.environ), format_storage=True)
        self.assertFalse(record.exists())
        self.assertEqual(list(tree.parent.glob(".pixelbox-flash-*")), [])

    def test_format_rejects_incompatible_geometry_before_compiling(self):
        tree = self.make_tree()
        config = tree / ".config"
        cases = [("CACHE_SIZE_FACTOR=4", "CACHE_SIZE_FACTOR=3"),
                 ("LOOKAHEAD_SIZE=0", "LOOKAHEAD_SIZE=7"),
                 ("BLOCK_CYCLE=200", "BLOCK_CYCLE=0"),
                 ("BLOCK_SIZE_FACTOR=1", "BLOCK_SIZE_FACTOR=3"),
                 ('VERSION="v2.5.1"', 'VERSION="v2.9.0"')]
        for before, after in cases:
            config.write_text(self.storage_config().replace(before, after))
            with self.subTest(after=after), self.assertRaises(ValueError), \
                    mock.patch.object(runner.subprocess, "run") as process:
                runner.create_storage_image(tree, config, self.root / "littlefs.bin", dict(os.environ))
            process.assert_not_called()

    def test_format_option_only_allowed_for_flash(self):
        for task in ("build", "merge", "configure", "clean"):
            with self.subTest(task=task), mock.patch("sys.stderr", new_callable=io.StringIO) as stderr:
                self.assertEqual(runner.main([task, "--format-storage"]), 1)
                self.assertIn("仅允许用于 flash", stderr.getvalue())

    def test_flash_uses_verified_snapshot_at_zero_without_make_or_header_rewrite(self):
        tree = self.make_tree()
        runner.collect(self.root, tree, "esp32s3", False)
        binary = tree.parent / "nuttx.bin"
        expected = binary.read_bytes()
        # Make 工作树与 merged 产物此后变化，也不能替换实际烧录的已收集镜像。
        (tree / "nuttx.bin").write_bytes(b"changed after collect")
        (tree / "nuttx").write_bytes(b"ELF from another build")
        (tree / "nuttx.merged.bin").write_bytes(bytes(0x1000000))
        tool, record = self.fake_esptool()
        for no_stub in (None, "CONFIG_ESP32S3_ESPTOOLPY_NO_STUB",
                        "CONFIG_ESPRESSIF_ESPTOOLPY_NO_STUB"):
            with self.subTest(no_stub=no_stub):
                (tree / ".config").write_text(self.valid_config() +
                                             (f"{no_stub}=y\n" if no_stub else ""))
                runner.flash(tree, binary, tool, "/dev/cu.fixture", 115200, dict(os.environ))
                call = json.loads(record.read_text())
                args = ["-c", "esp32s3", "-p", "/dev/cu.fixture", "-b", "115200"]
                if no_stub:
                    args.append("--no-stub")
                args += ["write_flash", "--flash_mode", "keep", "--flash_freq", "keep",
                         "--flash_size", "keep", "0x0"]
                self.assertEqual(call["argv"][:-1], args)
                self.assertEqual(call["size"], len(expected))
                self.assertEqual(call["sha256"], hashlib.sha256(expected).hexdigest())
                self.assertNotEqual(Path(call["argv"][-1]), binary)
                self.assertFalse(Path(call["argv"][-1]).exists())
        self.assertEqual(binary.read_bytes(), expected)

    def test_flash_rechecks_config_and_collected_image_before_opening_device(self):
        tree = self.make_tree()
        runner.collect(self.root, tree, "esp32s3", False)
        binary = tree.parent / "nuttx.bin"
        expected = binary.read_bytes()
        tool, record = self.fake_esptool()
        cases = (
            (self.valid_config().replace("0x800000", "0x1000000"), expected),
            (self.valid_config() + "CONFIG_ESPRESSIF_MERGE_BINS=y\n", expected),
            (self.valid_config(), b""),
            (self.valid_config(), expected.ljust(0x800001, b"\xff")),
            (self.valid_config(), expected.ljust(0x1000000, b"\xff")),
            (self.valid_config(), self.simple_boot_image()),
        )
        for config, image in cases:
            with self.subTest(size=len(image), config=config):
                (tree / ".config").write_text(config)
                binary.write_bytes(image)
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    runner.flash(tree, binary, tool, "/dev/cu.fixture", 115200, dict(os.environ))
                self.assertFalse(record.exists())
                self.assertEqual(list(tree.parent.glob(".pixelbox-flash-*")), [])

    def test_main_flash_never_reenters_make_flash(self):
        heap_tools = self.fake_heap_toolchain()
        kernel, apps, _, _ = self.source_trees()
        (kernel / "tools").mkdir()
        (kernel / "tools/configure.sh").write_text("configure")
        (kernel / "Kconfig").write_text("config")
        (apps / "Application.mk").write_text("apps")
        (apps / "interpreters").mkdir()
        (apps / "interpreters/Make.defs").write_text("apps")
        project = self.root / "project"
        tree = project / "build/esp32s3/nuttx"
        tree.mkdir(parents=True)
        (tree / ".config").write_text(self.valid_config())
        expected = image_tool.add_digest(self.simple_boot_image())
        (tree / "nuttx.bin").write_bytes(expected)
        (tree / "nuttx").write_bytes(b"ELF")
        (project / "pixelbox.json").write_text(json.dumps({"firmwareBackend": "nuttx"}))
        make = self.root / "make-fixture"
        make_record = self.root / "make-call.json"
        make.write_text(f"#!{sys.executable}\nimport json, pathlib, sys\n"
                        f"with pathlib.Path({str(make_record)!r}).open('a') as log:\n"
                        "    log.write(json.dumps(sys.argv[1:]) + '\\n')\n")
        make.chmod(0o755)
        tool, record = self.fake_esptool()
        with mock.patch.object(runner, "ROOT", project), \
                mock.patch.object(runner, "prepare", return_value=tree), \
                mock.patch.object(runner.shutil, "which", return_value=str(make)), \
                mock.patch.object(runner, "discover_toolchain", return_value=(heap_tools, "xtensa-esp32s3-elf-gcc")), \
                mock.patch.object(runner, "discover_kconfig_tools", return_value=(self.root, "conf", "tweak")), \
                mock.patch.object(runner, "discover_kconfiglib", return_value=None), \
                mock.patch.object(runner, "discover_esptool", return_value=tool):
            result = runner.main(["flash", "--nuttx-path", str(kernel), "--apps-path", str(apps),
                                  "--port", "/dev/cu.fixture", "--baud", "115200"])
        self.assertEqual(result, 0)
        calls = [json.loads(line) for line in make_record.read_text().splitlines()]
        self.assertEqual(len(calls), 1)
        self.assertNotIn("flash", calls[0])
        call = json.loads(record.read_text())
        self.assertEqual(call["argv"][-2], "0x0")
        self.assertEqual(call["sha256"], hashlib.sha256(expected).hexdigest())

    def test_missing_binary_is_not_success(self):
        tree = self.root / "tree"
        tree.mkdir()
        with self.assertRaisesRegex(ValueError, "未生成"):
            runner.collect(self.root, tree, "esp32s3", False)

    @unittest.skipIf(sys.platform == "win32", "POSIX build lock")
    def test_second_build_cannot_acquire_project_lock(self):
        with runner.project_lock(self.root):
            with self.assertRaisesRegex(ValueError, "正在运行"):
                with runner.project_lock(self.root):
                    self.fail("second task acquired lock")

    def test_compile_database_records_real_argv_and_exit(self):
        script = Path(__file__).parents[1] / "scripts/cc_capture.py"
        source = self.root / "source with spaces.c"
        source.write_text("int x;")
        compiler = self.root / "compiler.py"
        compiler.write_text("import sys\nsys.exit(3 if '--fail' in sys.argv else 0)\n")
        env = dict(os.environ, PX_NUTTX_COMPDB=str(self.root / "commands"))
        args = [sys.executable, str(script), sys.executable, str(compiler), "-c", str(source), "-DNAME=a b"]
        completed = subprocess.run(args, env=env, cwd=self.root, timeout=10, check=False)
        self.assertEqual(completed.returncode, 0)
        records = list((self.root / "commands").glob("*.json"))
        record = json.loads(records[0].read_text())
        self.assertEqual(record["arguments"], args[2:])
        self.assertEqual(record["file"], str(source))
        failed = subprocess.run(args + ["--fail"], env=env, cwd=self.root, timeout=10, check=False)
        self.assertEqual(failed.returncode, 3)


if __name__ == "__main__":
    unittest.main()
