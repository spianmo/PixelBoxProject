"""主机编译真实 NuttX mm_heap；只替代 OS、PSRAM/IMEM 地址和调度边界。"""
from pathlib import Path
import subprocess

HEADERS = {
    "nuttx/config.h": """
#pragma once
#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>
#include <strings.h>
#include <sys/types.h>
#define CONFIG_MM_REGIONS 1
#define CONFIG_MM_BACKTRACE -1
#define CONFIG_MM_HEAP_MEMPOOL_THRESHOLD -1
#define CONFIG_MM_FREE_DELAYCOUNT_MAX 0
#define CONFIG_SMP_NCPUS 1
#define CONFIG_BUILD_FLAT 1
#define CONFIG_DEBUG_ASSERTIONS 1
#define FAR
#define CODE
#define inline_function inline
#define UNUSED(x) ((void)(x))
typedef unsigned long irqstate_t;
""",
    "debug.h": """
#pragma once
#include <assert.h>
#define DEBUGASSERT(x) assert(x)
#define DEBUGVERIFY(x) assert((x) == 0)
#define minfo(...) ((void)0)
#define mwarn(...) ((void)0)
""",
    "nuttx/mutex.h": """
#pragma once
#include <pthread.h>
typedef pthread_mutex_t mutex_t;
#define nxmutex_init(m) pthread_mutex_init((m), NULL)
#define nxmutex_destroy(m) pthread_mutex_destroy(m)
#define nxmutex_lock(m) pthread_mutex_lock(m)
#define nxmutex_unlock(m) pthread_mutex_unlock(m)
static inline int nxmutex_is_locked(mutex_t *m) { int e=pthread_mutex_trylock(m); if (!e) pthread_mutex_unlock(m); return e != 0; }
""",
    "nuttx/sched.h": """
#pragma once
#define _SCHED_GETTID() 1
#define this_cpu() 0
""",
    "nuttx/arch.h": """
#pragma once
#include <nuttx/config.h>
static inline int up_interrupt_context(void) { return 0; }
static inline irqstate_t up_irq_save(void) { return 0; }
static inline void up_irq_restore(irqstate_t s) { (void)s; }
""",
    "nuttx/fs/procfs.h": "#pragma once\n",
    "nuttx/mm/mempool.h": "#pragma once\n",
    "nuttx/lib/math32.h": "#pragma once\n#define LOG2_CEIL(n) (64 - __builtin_clzll((n) - 1))\n",
    "nuttx/sched_note.h": "#pragma once\n#define sched_note_heap(...) ((void)0)\n",
    "nuttx/mm/kasan.h": """
#pragma once
#define kasan_register(p,s) ((void)(p),(void)(s))
#define kasan_unregister(p) ((void)(p))
#define kasan_poison(p,s) ((void)(p),(void)(s))
#define kasan_unpoison(p,s) ((void)(s),(void *)(p))
#define kasan_reset_tag(p) (p)
""",
    "nuttx/mm/mm.h": """
#pragma once
#include <nuttx/config.h>
#include <debug.h>
#define MM_ALIGN 8
#define PID_MM_ALLOC -3
#define PID_MM_FREE -4
#define MM_DUMP_ALLOC(task,node) ((task)->pid == PID_MM_ALLOC)
#define MM_DUMP_SEQNO(task,node) true
#define MM_DUMP_ASSIGN(task,node) false
#define MM_DUMP_LEAK(task,node) false
struct mallinfo { int arena, ordblks, aordblks, mxordblk, uordblks, fordblks, usmblks; };
struct malltask { pid_t pid; };
struct mallinfo_task { int aordblks, uordblks; };
struct mm_heap_s;
struct mm_heap_s *mm_initialize(const char *, void *, size_t);
void mm_uninitialize(struct mm_heap_s *);
void *mm_malloc(struct mm_heap_s *, size_t);
void *mm_memalign(struct mm_heap_s *, size_t, size_t);
void mm_free(struct mm_heap_s *, void *);
void mm_free_delaylist(struct mm_heap_s *);
size_t mm_malloc_size(struct mm_heap_s *, void *);
bool mm_heapmember(struct mm_heap_s *, void *);
struct mallinfo mm_mallinfo(struct mm_heap_s *);
""",
}
SOURCES = ["mm_initialize", "mm_malloc", "mm_free", "mm_memalign", "mm_malloc_size",
           "mm_shrinkchunk", "mm_heapmember", "mm_foreach", "mm_mallinfo", "mm_lock"]

def build(temp: Path, project: Path, cc: list[str], flags: list[str]) -> tuple[list[str], list[str]]:
    shim = temp / "mm-shim"
    for name, text in HEADERS.items():
        path = shim / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    nuttx = project.parent / ".deps/nuttx"
    includes = ["-I" + str(shim), "-I" + str(nuttx / "mm"), "-I" + str(project / "tests")]
    objects = []
    for name in SOURCES:
        obj = temp / (name + ".o")
        subprocess.run([*cc, *flags, *includes, "-Wno-unused-parameter", "-c",
                        str(nuttx / "mm/mm_heap" / (name + ".c")), "-o", str(obj)], check=True, timeout=60)
        objects.append(str(obj))
    return includes, objects
