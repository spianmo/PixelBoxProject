#include "pixelbox_mn7_abi.h"
#include <string.h>

/* 官方通用选择器会拉入 MN5/MN6；保留相同 ABI，仅接受实际嵌入的中文 MN7。 */
const esp_mn_iface_t *esp_mn_handle_from_name(const char *name)
{
  return name && !strcmp(name, "mn7_cn") ? &esp_sr_multinet7_quantized : NULL;
}
