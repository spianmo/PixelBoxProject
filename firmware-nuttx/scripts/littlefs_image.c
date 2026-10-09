/* 使用固件构建快照中的 LittleFS，在宿主生成并验证空数据分区。 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "bd/lfs_rambd.h"

#if LFS_VERSION != 0x00020005 || LFS_DISK_VERSION != 0x00020000
#error Unsupported LittleFS version
#endif

#define CHECK(call) do { \
  int result = (call); \
  if (result < 0) { fprintf(stderr, "%s: %d\n", #call, result); return 1; } \
} while (0)

int main(int argc, char **argv)
{
  if (argc != 9) return 1;
  lfs_rambd_t bd = {0};
  lfs_t fs = {0};
  struct lfs_config cfg = {
    .context = &bd,
    .read = lfs_rambd_read,
    .prog = lfs_rambd_prog,
    .erase = lfs_rambd_erase,
    .sync = lfs_rambd_sync,
    .read_size = strtoul(argv[2], NULL, 10),
    .prog_size = strtoul(argv[3], NULL, 10),
    .block_size = strtoul(argv[4], NULL, 10),
    .block_count = strtoul(argv[5], NULL, 10),
    .cache_size = strtoul(argv[6], NULL, 10),
    .lookahead_size = strtoul(argv[7], NULL, 10),
    .block_cycles = strtol(argv[8], NULL, 10)
  };
  size_t size = (size_t)cfg.block_size * cfg.block_count;
  if (size != 0x800000) return 1;
  struct lfs_rambd_config storage = {.erase_value = 255, .buffer = malloc(size)};
  cfg.read_buffer = malloc(cfg.cache_size);
  cfg.prog_buffer = malloc(cfg.cache_size);
  cfg.lookahead_buffer = malloc(cfg.lookahead_size);
  if (!storage.buffer || !cfg.read_buffer || !cfg.prog_buffer || !cfg.lookahead_buffer) return 1;

  /* 全分区初始化为擦除态，再创建应用管理器需要的目录。 */
  CHECK(lfs_rambd_createcfg(&cfg, &storage));
  CHECK(lfs_format(&fs, &cfg));
  CHECK(lfs_mount(&fs, &cfg));
  CHECK(lfs_mkdir(&fs, "/app"));
  CHECK(lfs_mkdir(&fs, "/app/assets"));
  CHECK(lfs_unmount(&fs));
  FILE *file = fopen(argv[1], "wb");
  if (!file) return 1;
  int written = fwrite(storage.buffer, 1, size, file) == size;
  if (fclose(file) != 0 || !written) return 1;

  /* 从实际导出的文件重新加载并挂载，验证待烧录字节而非仅验证内存状态。 */
  memset(storage.buffer, 0, size);
  file = fopen(argv[1], "rb");
  if (!file) return 1;
  int loaded = fread(storage.buffer, 1, size, file) == size && fgetc(file) == EOF;
  if (fclose(file) != 0 || !loaded) return 1;
  CHECK(lfs_mount(&fs, &cfg));
  const char *directories[] = {"/app", "/app/assets"};
  for (size_t i = 0; i < sizeof(directories) / sizeof(directories[0]); i++) {
    struct lfs_info info;
    CHECK(lfs_stat(&fs, directories[i], &info));
    if (info.type != LFS_TYPE_DIR) return 1;
  }
  CHECK(lfs_unmount(&fs));
  CHECK(lfs_rambd_destroy(&cfg));
  free(storage.buffer);
  free(cfg.read_buffer);
  free(cfg.prog_buffer);
  free(cfg.lookahead_buffer);
  puts("LittleFS image: format + exported-image mount verified");
  return 0;
}
