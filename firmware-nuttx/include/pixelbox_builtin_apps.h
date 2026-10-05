#ifndef PIXELBOX_BUILTIN_APPS_H
#define PIXELBOX_BUILTIN_APPS_H

#include <stddef.h>

enum px_builtin_app_id {
  PX_BUILTIN_SETTINGS = 0,
  PX_BUILTIN_WELCOME
};

struct px_builtin_app {
  const char *source;
  size_t length;
  const char *filename;
  const char *sha256;
};

/* 返回原 ESP-IDF JS 的逐字节静态副本；末尾额外 NUL 不计入 length。
 * 可直接放入 px_options.eval_source，不分配内存、不得由调用者释放。
 * 未知 id 返回 NULL，不能用编造的备用界面掩盖资源缺失。
 */
const struct px_builtin_app *px_builtin_app_get(enum px_builtin_app_id id);

#endif
