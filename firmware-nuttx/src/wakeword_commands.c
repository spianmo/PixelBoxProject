/* ESP-SR 公布的命令表 ABI；仅为真模型构建命令图，不产生识别结果。 */
#include "pixelbox_mn7_abi.h"
#include "pixelbox_mn7_memory.h"
#include <limits.h>
#include <stdlib.h>
#include <string.h>

enum { MN_OK = 0, MN_NOMEM = 0x101, MN_INVALID = 0x102, MN_STATE = 0x103 };
static esp_mn_node_t root;
static const esp_mn_iface_t *iface;
static model_iface_data_t *model;
static unsigned count;

void px_mn7_commands_forget(void)
{
  /* OOM 后节点图可以只构造了一半；由工作区统一释放，不能沿图遍历。 */
  memset(&root, 0, sizeof(root)); iface = NULL; model = NULL; count = 0;
}

int esp_mn_commands_clear(void)
{
  esp_mn_node_t *p = root.next;
  while (p) {
    esp_mn_node_t *next = p->next;
    px_mn7_free(p->phrase->string); px_mn7_free(p->phrase->phonemes); px_mn7_free(p->phrase->wave);
    px_mn7_free(p->phrase); px_mn7_free(p); p = next;
  }
  root.next = NULL; count = 0; return MN_OK;
}
int esp_mn_commands_free(void)
{
  esp_mn_commands_clear(); iface = NULL; model = NULL; return MN_OK;
}
int esp_mn_commands_alloc(const esp_mn_iface_t *api, model_iface_data_t *data)
{
  if (!api || !data || !api->check_speech_command || !api->set_speech_commands) return MN_INVALID;
  esp_mn_commands_free(); iface = api; model = data; return MN_OK;
}
esp_mn_phrase_t *esp_mn_commands_get_from_string(const char *text)
{
  if (!text) return NULL;
  for (esp_mn_node_t *p = root.next; p; p = p->next)
    if (!strcmp(text, p->phrase->string)) return p->phrase;
  return NULL;
}
int esp_mn_commands_phoneme_add(int id, const char *text, const char *phonemes)
{
  if (!iface || !model) return MN_STATE;
  if (id < INT16_MIN || id > INT16_MAX || !text || !*text || strlen(text) > 63 ||
      (phonemes && strlen(phonemes) > 255)) return MN_INVALID;
  if (!iface->check_speech_command(model, text)) return MN_INVALID;
  esp_mn_phrase_t *old = esp_mn_commands_get_from_string(text);
  if (old) { old->command_id = (int16_t)id; return MN_OK; }
  if (count >= 400) return MN_STATE;
  esp_mn_node_t *node = px_mn7_calloc(1, sizeof(*node));
  esp_mn_phrase_t *phrase = px_mn7_calloc(1, sizeof(*phrase));
  char *copy = px_mn7_strdup(text), *phoneme_copy = phonemes ? px_mn7_strdup(phonemes) : NULL;
  if (!node || !phrase || !copy || (phonemes && !phoneme_copy)) {
    px_mn7_free(node); px_mn7_free(phrase); px_mn7_free(copy); px_mn7_free(phoneme_copy); return MN_NOMEM;
  }
  phrase->string = copy; phrase->phonemes = phoneme_copy; phrase->command_id = (int16_t)id;
  node->phrase = phrase;
  esp_mn_node_t *last = &root; while (last->next) last = last->next;
  last->next = node; ++count; return MN_OK;
}
int esp_mn_commands_add(int id, const char *text) { return esp_mn_commands_phoneme_add(id, text, NULL); }
esp_mn_error_t *esp_mn_commands_update(void)
{
  static esp_mn_error_t invalid = {.num = 1};
  if (!iface || !model) return &invalid;
  esp_mn_error_t *result = iface->set_speech_commands(model, &root);
  return result && result->num == 0 ? NULL : result ? result : &invalid;
}
