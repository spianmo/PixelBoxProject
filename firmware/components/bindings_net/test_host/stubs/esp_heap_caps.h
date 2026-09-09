#pragma once
#include <cstddef>
constexpr int MALLOC_CAP_SPIRAM = 1, MALLOC_CAP_8BIT = 2;
void* heap_caps_malloc(size_t, int);
void heap_caps_free(void*);
