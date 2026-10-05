#include "pixelbox_builtin_apps.h"
#include "builtin_apps_data.h"

static const struct px_builtin_app g_settings = {
  (const char *)px_builtin_settings_source,
  sizeof(px_builtin_settings_source) - 1,
  "<builtin:settings>", PX_BUILTIN_SETTINGS_SHA256
};

static const struct px_builtin_app g_welcome = {
  (const char *)px_builtin_welcome_source,
  sizeof(px_builtin_welcome_source) - 1,
  "<builtin:welcome>", PX_BUILTIN_WELCOME_SHA256
};

const struct px_builtin_app *px_builtin_app_get(enum px_builtin_app_id id)
{
  if (id == PX_BUILTIN_SETTINGS) return &g_settings;
  if (id == PX_BUILTIN_WELCOME) return &g_welcome;
  return NULL;
}
