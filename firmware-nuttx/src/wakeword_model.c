/* 只读模型目录：先做全量 SHA256 和边界校验，再向真实 MN7 暴露指针。 */
#include "pixelbox_mn7_abi.h"
#include "pixelbox_mn7_memory.h"
#include "pixelbox_sha256.h"
#include <errno.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static srmodel_list_t models;
static srmodel_list_t *loaded;
static const uint8_t *archive;

void px_mn7_model_forget(void)
{
  /* 半初始化目录的所有分配仍由工作区登记；只复位根，不解引用残留指针。 */
  memset(&models, 0, sizeof(models)); loaded = NULL; archive = NULL;
}

static uint32_t u32(const uint8_t *p)
{
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

void px_mn7_model_unload(void)
{
  for (int i = 0; i < models.num; ++i) {
    srmodel_data_t *data = models.model_data ? models.model_data[i] : NULL;
    if (data) { px_mn7_free(data->files); px_mn7_free(data->data); px_mn7_free(data->sizes); px_mn7_free(data); }
    if (models.model_info) px_mn7_free(models.model_info[i]);
  }
  px_mn7_free(models.model_name); px_mn7_free(models.model_info); px_mn7_free(models.model_data);
  px_mn7_model_forget();
}

static bool name_ok(const uint8_t *p)
{
  const uint8_t *end = memchr(p, 0, 32);
  if (!end || end == p) return false;
  for (; p < end; ++p) if (*p < 32 || *p > 126 || *p == '/' || *p == '\\') return false;
  return true;
}

int px_mn7_model_load(const uint8_t *bytes, size_t size, const uint8_t expected[32])
{
  if (loaded) return archive == bytes ? 0 : -EBUSY;
  if (!bytes || !expected || size < 40 || size > 4u * 1024 * 1024) return -EINVAL;
  uint8_t digest[32]; px_sha256(bytes, size, digest);
  if (memcmp(digest, expected, 32)) return -EBADMSG;
  uint32_t count = u32(bytes);
  if (!count || count > 8) return -EBADMSG;
  size_t offset = 4, first_payload = size;
  unsigned required = 0;
  bool found = false;
  /* 第一遍绝不分配或暴露未验证指针；目录重叠、重复模型和缺文件均拒绝。 */
  for (uint32_t i = 0; i < count; ++i) {
    if (offset > size - 36 || !name_ok(bytes + offset)) return -EBADMSG;
    bool mn7 = !strcmp((const char *)bytes + offset, "mn7_cn");
    if (mn7 && found) return -EBADMSG;
    found |= mn7;
    uint32_t files = u32(bytes + offset + 32); offset += 36;
    if (!files || files > 16 || files > (size - offset) / 40) return -EBADMSG;
    static const char *names[] = {"mn7_index", "mn7_data", "_MODEL_INFO_", "vocab"};
    for (uint32_t j = 0; j < files; ++j, offset += 40) {
      if (!name_ok(bytes + offset)) return -EBADMSG;
      size_t begin = u32(bytes + offset + 32), length = u32(bytes + offset + 36);
      if (!length || begin > size || length > size - begin) return -EBADMSG;
      if (begin < first_payload) first_payload = begin;
      if (mn7) for (unsigned k = 0; k < 4; ++k) if (!strcmp((const char *)bytes + offset, names[k])) {
        if (required & (1u << k)) return -EBADMSG;
        required |= 1u << k;
      }
    }
  }
  if (!found || required != 15 || offset > first_payload) return -EBADMSG;
  models.num = (int)count;
  models.model_name = px_mn7_calloc(count, sizeof(char *));
  models.model_info = px_mn7_calloc(count, sizeof(char *));
  models.model_data = px_mn7_calloc(count, sizeof(srmodel_data_t *));
  if (!models.model_name || !models.model_info || !models.model_data) goto nomem;
  offset = 4;
  for (uint32_t i = 0; i < count; ++i) {
    models.model_name[i] = (char *)bytes + offset;
    uint32_t files = u32(bytes + offset + 32); offset += 36;
    srmodel_data_t *data = px_mn7_calloc(1, sizeof(*data));
    if (!data) goto nomem;
    models.model_data[i] = data; data->num = (int)files;
    data->files = px_mn7_calloc(files, sizeof(char *));
    data->data = px_mn7_calloc(files, sizeof(char *));
    data->sizes = px_mn7_calloc(files, sizeof(int));
    if (!data->files || !data->data || !data->sizes) goto nomem;
    for (uint32_t j = 0; j < files; ++j, offset += 40) {
      data->files[j] = (char *)bytes + offset;
      data->data[j] = (char *)bytes + u32(bytes + offset + 32);
      data->sizes[j] = (int)u32(bytes + offset + 36);
      if (!strcmp(data->files[j], "_MODEL_INFO_")) {
        const char *p = data->data[j]; size_t left = (size_t)data->sizes[j];
        while (left && *p == '#') { while (left && *p != '\n') { ++p; --left; } if (left) { ++p; --left; } }
        char *info = px_mn7_calloc(left + 1, 1); if (!info) goto nomem;
        memcpy(info, p, left); if (left && info[left - 1] == '\n') info[left - 1] = 0;
        models.model_info[i] = info;
      }
    }
  }
  archive = bytes; loaded = &models;
  return 0;
nomem:
  px_mn7_model_unload(); return -ENOMEM;
}

srmodel_list_t *get_static_srmodels(void) { return loaded; }
char *get_model_base_path(void) { return NULL; }

#ifdef PX_MULTINET7
#include "wakeword/model_manifest.h"
extern const uint8_t px_mn7_archive[], px_mn7_archive_end[];
int px_mn7_model_builtin(void)
{
  return px_mn7_model_load(px_mn7_archive, (size_t)(px_mn7_archive_end - px_mn7_archive), px_mn7_archive_sha256);
}
#endif
