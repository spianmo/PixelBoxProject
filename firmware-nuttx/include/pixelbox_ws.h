#ifndef PIXELBOX_NUTTX_WS_H
#define PIXELBOX_NUTTX_WS_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

struct px_ws_decoder;
struct px_ws_event {unsigned opcode;uint8_t *data;size_t length;};
/* server=true要求客户端掩码；server=false禁止服务端掩码。feed可消费任意碎片，
 * 每次最多产出一条完整消息/控制帧；事件data由调用方free。错误为负errno。 */
struct px_ws_decoder *px_ws_decoder_create(bool server,size_t message_limit);
void px_ws_decoder_free(struct px_ws_decoder *decoder);
int px_ws_feed(struct px_ws_decoder *decoder,const uint8_t *data,size_t length,
               size_t *consumed,struct px_ws_event *event);
int px_ws_frame(unsigned opcode,bool fin,const void *data,size_t length,
                const uint8_t mask[4],uint8_t **out,size_t *out_length);
bool px_ws_utf8(const uint8_t *bytes,size_t length);
bool px_ws_close_code(unsigned code);
/* RFC6455握手与严格base64；accept输出包含结尾NUL，共29字节。 */
int px_ws_accept(const char *key,char out[29]);
int px_base64_encode(const uint8_t *data,size_t length,char *out,size_t capacity);
int px_base64_decode(const char *text,size_t length,uint8_t *out,size_t capacity,size_t *written);
#endif
