/* 只在测试构建替换线程创建/回收，统计真实栈生命周期并注入资源不足。 */
#include <pthread.h>
int px_test_pthread_create(pthread_t *, const pthread_attr_t *, void *(*)(void *), void *);
int px_test_pthread_join(pthread_t, void **);
#define pthread_create px_test_pthread_create
#define pthread_join px_test_pthread_join
#include "../src/portal.c"
#ifdef PX_PORTAL_STACK_PROBE
/* 宿主通常分配1MiB栈；压力fixture使用生产常量，不改写被测portal.c。 */
size_t px_test_portal_worker_stack(void *(*entry)(void *))
{
  return entry == controller_worker ? PX_PORTAL_CONTROLLER_STACK_BYTES : PX_PORTAL_DHCP_STACK_BYTES;
}
#endif
