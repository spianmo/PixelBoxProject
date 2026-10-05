#ifndef PIXELBOX_NUTTX_STORE_H
#define PIXELBOX_NUTTX_STORE_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#define PX_STORE_MAX_FILES 128
#define PX_STORE_MAX_PATH 240
#define PX_STORE_FILE_BYTES (4u*1024u*1024u)
#define PX_STORE_TOTAL_BYTES (16u*1024u*1024u)
#define PX_STORE_MANIFEST_BYTES 8192
#define PX_STORE_CHUNK_BYTES 32768
struct px_store;
struct px_store_file {const char *path;size_t size;uint8_t sha256[32];};
/* root下仅操作staging/current/prev；所有相对路径按目录fd逐层O_NOFOLLOW。 */
struct px_store *px_store_open(const char *root);
void px_store_close(struct px_store *store);
bool px_store_valid_path(const char *path);
int px_store_begin(struct px_store *store,const char *manifest,const char *entry,
                   const struct px_store_file *files,size_t count);
int px_store_write(struct px_store *store,const char *path,size_t offset,const void *data,size_t length);
int px_store_verify(struct px_store *store);
/* 先验证全部文件再current→prev→staging重命名；第二步失败时恢复current。
 * 重启发现current缺失且prev存在时优先恢复旧版本，不猜测未提交的staging。 */
int px_store_commit(struct px_store *store);
int px_store_abort(struct px_store *store);
int px_store_current_root(struct px_store *store,char *out,size_t capacity);
int px_store_manifest(struct px_store *store,char **out); /* 调用方free。 */
#endif
