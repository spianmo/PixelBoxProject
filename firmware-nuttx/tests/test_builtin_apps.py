#!/usr/bin/env python3
"""编译实际 getter 后比对原 JS 全部字节，验证离线来源及错误边界。"""
from pathlib import Path
import hashlib
import importlib.util
import os
import shlex
import subprocess
import tempfile
import unittest

PROJECT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("prepare_builtin_apps", PROJECT / "tools/prepare_builtin_apps.py")
PREPARE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREPARE)

HARNESS = r'''
#include "pixelbox_builtin_apps.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv)
{
  assert(argc == 2);
  assert(px_builtin_app_get((enum px_builtin_app_id)-1) == NULL);
  assert(px_builtin_app_get((enum px_builtin_app_id)2) == NULL);
  const struct px_builtin_app *app = px_builtin_app_get((enum px_builtin_app_id)atoi(argv[1]));
  assert(app && app->source[app->length] == '\0');
  printf("%zu %s %s\n", app->length, app->sha256, app->filename);
  assert(fwrite(app->source, 1, app->length, stdout) == app->length);
  return 0;
}
'''


class BuiltinAppsTests(unittest.TestCase):
    def test_actual_c_getter_preserves_all_source_bytes(self):
        with tempfile.TemporaryDirectory(prefix="px-builtin-test-") as temporary:
            build = Path(temporary)
            manifest = PREPARE.prepare(PROJECT, PROJECT.parent, build)
            timestamp = (build / "builtin_apps_data.h").stat().st_mtime_ns
            PREPARE.prepare(PROJECT, PROJECT.parent, build)
            self.assertEqual(timestamp, (build / "builtin_apps_data.h").stat().st_mtime_ns)
            (build / "runner.c").write_text(HARNESS)
            runner = build / "runner"
            subprocess.run([*shlex.split(os.environ.get("CC", "cc")), "-std=c11", "-Wall", "-Wextra", "-Werror",
                            "-I" + str(PROJECT / "include"), "-I" + str(build), str(PROJECT / "src/builtin_apps.c"),
                            str(build / "runner.c"), "-o", str(runner)], check=True, timeout=60)
            for index, (name, filename) in enumerate((("settings", "settings_app.js"), ("welcome", "default_app.js"))):
                original = (PROJECT.parent / "firmware/components/appmgr/src" / filename).read_bytes()
                output = subprocess.check_output([str(runner), str(index)], timeout=60)
                header, source = output.split(b"\n", 1)
                self.assertEqual(source, original)
                self.assertEqual(header.decode(), f"{len(original)} {hashlib.sha256(original).hexdigest()} <builtin:{name}>")
                self.assertEqual(manifest[name]["length"], len(original))

    def test_packaged_sources_missing_and_nul(self):
        with tempfile.TemporaryDirectory(prefix="px-builtin-package-") as temporary:
            root = Path(temporary)
            shared = root / "project/shared"
            shared.mkdir(parents=True)
            with self.assertRaises(FileNotFoundError):
                PREPARE.prepare(root / "project", root / "missing", root / "generated")
            (shared / "settings_app.js").write_bytes(b"/* original CRLF */\r\nconsole.log('a');\r\n")
            (shared / "default_app.js").write_bytes(b"console.log('welcome');\n")
            manifest = PREPARE.prepare(root / "project", root / "missing", root / "generated")
            self.assertEqual(manifest["settings"]["sha256"], hashlib.sha256((shared / "settings_app.js").read_bytes()).hexdigest())
            (shared / "settings_app.js").write_bytes(b"x\0y")
            with self.assertRaises(ValueError):
                PREPARE.prepare(root / "project", root / "missing", root / "generated")


if __name__ == "__main__":
    unittest.main()
