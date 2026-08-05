/*
 * gifdec — 单文件 GIF 解码器 (vendored)
 *
 * 来源: https://github.com/lecram/gifdec (public domain,见仓库 README/UNLICENSE)
 * PixelBox 修改说明 (以 [PixelBox] 标注):
 *   1. 原版基于 POSIX fd (open/read/lseek);嵌入式上希望直接解码内存中的
 *      GIF 数据 (JS 传入 ArrayBuffer),故将 fd 替换为内存读取器 gd_Reader。
 *   2. 新增 gd_open_gif_data(data, size) 从内存打开;gd_open_gif(fname)
 *      保留,内部整体读文件到内存后委托前者。
 *   3. gd_GIF 增加 owned_data 字段用于 gd_close_gif 释放文件缓冲。
 */
#ifndef GIFDEC_H
#define GIFDEC_H

#include <stdint.h>
#include <stddef.h>
#include <sys/types.h>

#ifdef __cplusplus
extern "C" {
#endif

/* [PixelBox] 内存读取器,替代 POSIX fd */
typedef struct gd_Reader {
    const uint8_t *data;
    size_t size;
    size_t pos;
} gd_Reader;

typedef struct gd_Palette {
    int size;
    uint8_t colors[0x100 * 3];
} gd_Palette;

typedef struct gd_GCE {
    uint16_t delay;
    uint8_t tindex;
    uint8_t disposal;
    int input;
    int transparency;
} gd_GCE;

typedef struct gd_GIF {
    gd_Reader rd;         /* [PixelBox] 原为 int fd */
    uint8_t *owned_data;  /* [PixelBox] 经 gd_open_gif(fname) 打开时持有文件缓冲 */
    off_t anim_start;
    uint16_t width, height;
    uint16_t depth;
    uint16_t loop_count;
    gd_GCE gce;
    gd_Palette *palette;
    gd_Palette lct, gct;
    void (*plain_text)(
        struct gd_GIF *gif, uint16_t tx, uint16_t ty,
        uint16_t tw, uint16_t th, uint8_t cw, uint8_t ch,
        uint8_t fg, uint8_t bg
    );
    void (*comment)(struct gd_GIF *gif);
    void (*application)(struct gd_GIF *gif, char id[8], char auth[3]);
    uint16_t fx, fy, fw, fh;
    uint8_t bgindex;
    uint8_t *canvas, *frame;
} gd_GIF;

gd_GIF *gd_open_gif(const char *fname);
/* [PixelBox] 从内存数据打开;data 生命周期须覆盖整个解码过程 (内部不拷贝) */
gd_GIF *gd_open_gif_data(const void *data, size_t size);
int gd_get_frame(gd_GIF *gif);
void gd_render_frame(gd_GIF *gif, uint8_t *buffer);
int gd_is_bgcolor(gd_GIF *gif, uint8_t color[3]);
void gd_rewind(gd_GIF *gif);
void gd_close_gif(gd_GIF *gif);

#ifdef __cplusplus
}
#endif

#endif /* GIFDEC_H */
