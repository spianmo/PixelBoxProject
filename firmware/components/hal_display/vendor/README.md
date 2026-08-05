# vendored 第三方源码

| 文件 | 来源 | 版本/日期 | 许可 | 修改 |
|---|---|---|---|---|
| `pngle.c` / `pngle.h` | [kikuchan/pngle](https://github.com/kikuchan/pngle) | master @ 2026-08 | MIT | 无修改 |
| `miniz.c` / `miniz.h` | pngle 仓库自带 (richgel999/miniz) | 同上 | MIT | 无修改;编译时以 `MINIZ_NO_*` 宏裁剪 |
| `gifdec.c` / `gifdec.h` | [lecram/gifdec](https://github.com/lecram/gifdec) | master @ 2026-08 | Public Domain | **有修改**:POSIX fd 改为内存读取器 `gd_Reader`,新增 `gd_open_gif_data()`;修改点以 `[PixelBox]` 注释标注 |

> 更新方式:重新下载上游文件后,对 gifdec 重放 `[PixelBox]` 标注的改造
> (读取器结构 + `gd_open_gif_data` + `gd_close_gif` 释放逻辑)。
