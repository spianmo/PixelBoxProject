# NuttX TLS transport 接入

`src/tls.c` 实现非阻塞 TLS 1.2 客户端。`net.c` 的连接 worker 持有握手截止时间和取消状态；握手成功后把 TLS 与 fd 一起移交 VM 主线程。TLS 模块不关闭 fd，也不等待对端关闭握手。

## 固定使用 HAL 中的一套 mbedTLS

生产端必须使用 `esp-hal-3rdparty` 中已应用 NuttX 前缀补丁的 mbedTLS 3.6.0 头文件、源码和 `mbedtls/esp_config.h`。函数为 `esp_mbedtls_*`，结构类型仍为 `mbedtls_*`。禁止单独启另一套配置后链接现有 HAL crypto。

共享构建入口由集成方修改；本模块不修改 runner、项目 Makefile、配置或 `.deps`。在隔离快照创建完成且 HAL 已物化后调用：

```sh
python3 scripts/tls_build_patch.py build/esp32s3/nuttx
```

该脚本只向 `Wireless.mk` 补齐以下九个已有源码：

```text
ssl_tls.c ssl_msg.c ssl_client.c ssl_tls12_client.c ssl_tls12_server.c
ssl_ciphersuites.c x509.c x509_crt.c x509_crl.c
```

SDK 同时启用了 client/server，故 `ssl_tls.c` 会引用 TLS 1.2 服务端入口，虽然 PixelBox 仅暴露客户端，仍须编译 `ssl_tls12_server.c`。现有 VPATH 已经为 `base64.c` 选中 mbedTLS 版本；不要重复添加。现有 HAL crypto、PEM、entropy 继续复用。

应用 Makefile 添加 `src/tls.c`、`-DPX_TLS_MBEDTLS`，以及与 HAL 完全相同的 `-DMBEDTLS_CONFIG_FILE=<mbedtls/esp_config.h>`。令 `HAL=$(TOPDIR)/arch/xtensa/src/chip/esp-hal-3rdparty`，所需 include 目录为：

```text
$(HAL)/components/mbedtls/mbedtls/include
$(HAL)/components/mbedtls/port/include
$(HAL)/components/soc/esp32s3/include
$(HAL)/components/esp_rom/include
$(HAL)/nuttx/esp32s3/include
```

`tls.c` 为该配置缺失的 `esp_mbedtls_ms_time()` 提供 `CLOCK_MONOTONIC` 平台实现。SDK 选择了 `MBEDTLS_PLATFORM_MS_TIME_ALT`，但原 `esp_timing.c` 没有实现这个 3.6 接口。不要重复编译 `platform_util.c` 或加入异配置的库。TLS allocator 仍使用 HAL 的 `kmm_calloc/kmm_free`，不会因启用 Xtensa 独立内部堆而自动迁移。

## 信任、时钟和资源边界

- 默认优先读取 `/data/certs/ca-bundle.pem`，可用编译宏 `PX_TLS_CA_FILE` 指定可信 CA 文件。ESP32-S3 固件启用 `PX_TLS_BUILTIN_CA`，仅在该文件不存在（ENOENT）时使用 `certs/mozilla-idf-20250225.pem` 中的150张公开CA；快照固定为2025-02-25，来源与SHA256记录于 `certs/manifest.json`，不是最新证书集合。损坏、空内容、权限错误等覆盖文件错误仍失败，不回退。未启用内置集合的host构建在缺文件时返回 `-ENOTSUP`。
- 系统时间须先同步；早于 2024-01-01 返回 `-ETIME`。该阈值只排除未初始化时钟，不能证明系统时间准确。签名、信任链、主机名和每张证书的有效期均须通过。HAL 未启用 `MBEDTLS_HAVE_TIME_DATE`，因此模块使用验证回调补齐日期检查，绝不清除库的错误标志。
- 最多四个 TLS context，CA 文件上限 256 KiB，每次 write 最多 4096 字节。上下文仅允许一个线程同时使用。
- `write` 返回 `-EAGAIN` 后重试相同内容，只有正数返回才推进偏移；内部保持稳定缓冲地址。不同重试内容返回 `-EBUSY`。重试期间 read 返回 `-EAGAIN`，`poll_events()` 保留实际 WANT_READ/WANT_WRITE。
- 非空 read 的 0 仅代表认证过的 `close_notify`；原始 TCP EOF 返回 `-ECONNRESET`，避免将截断内容当成完整响应。

## 验证记录与边界

2026-10-01，以下命令均通过：

```sh
python3 tests/test_tls.py
python3 tests/test_tls.py --sanitize undefined
python3 tests/test_tls_build_patch.py
```

宿主测试使用已有 Homebrew mbedTLS 3.6.3 与 Python/OpenSSL TLS 服务端，在临时目录创建证书；17 个场景覆盖收发、部分写、背压重试、pending 明文、干净关闭、截断 EOF、主机名/CA/证书日期拒绝、时钟丢失、非阻塞握手取消、资源限制和 descriptor 保留，以及实际公开CA集合解析、缺文件回退、损坏/空覆盖文件拒绝和有效覆盖文件真实TLS握手。测试CA及私钥不会写入生产目录。

另外使用实际 NuttX 配置、HAL 前缀版 3.6.0 头文件和 Xtensa 工具链，在独立临时目录编译 transport 与九个增量源码，并与既有 `libarch.a` 比对所需符号。此验证不等于真机 HTTPS/WSS 已通过；最终完整固件链接、真实 CA/时钟部署及联网握手必须由真机流程确认。
