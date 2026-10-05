#ifndef PIXELBOX_MN7_ABI_H
#define PIXELBOX_MN7_ABI_H

/* ESP-SR 2.5.3 的公开 C ABI；S3 库以 ESP_PLATFORM 构建，partition 槽不可省略。 */
#include <stddef.h>
#include <stdint.h>

typedef struct model_iface_data_t model_iface_data_t;
typedef enum { ESP_MN_STATE_DETECTING, ESP_MN_STATE_DETECTED, ESP_MN_STATE_TIMEOUT } esp_mn_state_t;
typedef struct {
  esp_mn_state_t state;
  int num, command_id[5], phrase_id[5];
  float prob[5];
  char string[256], raw_string[256];
} esp_mn_results_t;
typedef struct {
  char *string, *phonemes;
  int16_t command_id;
  float threshold;
  int16_t *wave;
} esp_mn_phrase_t;
typedef struct esp_mn_node {
  esp_mn_phrase_t *phrase;
  struct esp_mn_node *next;
} esp_mn_node_t;
typedef struct { int16_t num; esp_mn_phrase_t **phrases; } esp_mn_error_t;
typedef struct {
  model_iface_data_t *(*create)(const char *, int);
  int (*get_samp_rate)(model_iface_data_t *);
  int (*get_samp_chunksize)(model_iface_data_t *);
  int (*get_samp_chunknum)(model_iface_data_t *);
  int (*set_det_threshold)(model_iface_data_t *, float);
  char *(*get_language)(model_iface_data_t *);
  esp_mn_state_t (*detect)(model_iface_data_t *, int16_t *);
  void (*destroy)(model_iface_data_t *);
  esp_mn_results_t *(*get_results)(model_iface_data_t *);
  void (*open_log)(model_iface_data_t *);
  void (*clean)(model_iface_data_t *);
  esp_mn_error_t *(*set_speech_commands)(model_iface_data_t *, esp_mn_node_t *);
  model_iface_data_t *(*switch_loader_mode)(model_iface_data_t *, int);
  void (*print_active_speech_commands)(model_iface_data_t *);
  int (*check_speech_command)(model_iface_data_t *, const char *);
} esp_mn_iface_t;
typedef struct { int num; char **files, **data; int *sizes; } srmodel_data_t;
typedef struct {
  char **model_name, **model_info;
  void *partition, *mmap_handle;
  int num;
  srmodel_data_t **model_data;
} srmodel_list_t;

#if UINTPTR_MAX == UINT32_MAX
_Static_assert(offsetof(srmodel_list_t, num) == 16, "ESP-SR model count ABI");
_Static_assert(offsetof(srmodel_list_t, model_data) == 20, "ESP-SR model data ABI");
_Static_assert(sizeof(esp_mn_iface_t) == 60, "ESP-SR vtable ABI");
_Static_assert(sizeof(esp_mn_phrase_t) == 20, "ESP-SR phrase ABI");
_Static_assert(sizeof(esp_mn_results_t) == 580, "ESP-SR results ABI");
#endif

extern const esp_mn_iface_t esp_sr_multinet7_quantized;
const esp_mn_iface_t *esp_mn_handle_from_name(const char *name);
int esp_mn_commands_alloc(const esp_mn_iface_t *, model_iface_data_t *);
int esp_mn_commands_free(void);
int esp_mn_commands_clear(void);
int esp_mn_commands_add(int id, const char *text);
int esp_mn_commands_phoneme_add(int id, const char *text, const char *phonemes);
esp_mn_phrase_t *esp_mn_commands_get_from_string(const char *text);
esp_mn_error_t *esp_mn_commands_update(void);
srmodel_list_t *get_static_srmodels(void);
char *get_model_base_path(void);
int px_mn7_model_load(const uint8_t *bytes, size_t size, const uint8_t expected[32]);
void px_mn7_model_unload(void);
int px_mn7_model_builtin(void);

#endif
