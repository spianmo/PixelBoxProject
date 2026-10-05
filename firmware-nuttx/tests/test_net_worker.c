#include "pixelbox_net.h"
#include "net_worker_test_platform.h"
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static void sleep_ms(unsigned ms)
{ struct timespec delay = {ms / 1000, (long)(ms % 1000) * 1000000}; nanosleep(&delay, NULL); }

static void wait_workers(void)
{
  for (unsigned i = 0; i < 2000; ++i) {
    struct px_net_test_stats state = px_net_test_snapshot();
    if (state.started == state.finished) return;
    sleep_ms(1);
  }
  assert(!"network workers did not finish");
}

static void clean(void)
{
  wait_workers();
  struct px_net_test_stats state = px_net_test_snapshot();
  assert(state.fds == 0 && state.borrowed == 0 && state.pending == 0);
}

static int listening(unsigned *port)
{
  int fd = socket(AF_INET, SOCK_STREAM, 0); assert(fd >= 0);
  struct sockaddr_in address = {.sin_family = AF_INET};
  assert(inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) == 1);
  assert(bind(fd, (struct sockaddr *)&address, sizeof(address)) == 0);
  assert(listen(fd, 4) == 0);
  socklen_t length = sizeof(address);
  assert(getsockname(fd, (struct sockaddr *)&address, &length) == 0);
  *port = ntohs(address.sin_port); return fd;
}

static struct px_net_event next(struct px_net *net)
{
  for (unsigned i = 0; i < 3000; ++i) {
    struct px_net_event event;
    int result = px_net_poll(net, &event); assert(result >= 0);
    if (result == 1) return event;
    sleep_ms(1);
  }
  assert(!"missing network event");
  return (struct px_net_event){0};
}

static void transfer_test(enum px_net_test_failure failure)
{
  unsigned port; int server = listening(&port);
  struct px_net *net = px_net_create(); assert(net);
  uint32_t id, reserved; unsigned reserve_port;
  /* VM 先占 fd=3，worker 也从 fd=3 建连接；正确实现必须导入新 fd。 */
  assert(px_net_udp(net, 0, &reserved, &reserve_port) == 0);
  px_net_test_fail(failure);
  assert(px_net_connect(net, "localhost", port, false, 2000, &id) == 0);
  struct px_net_event event = next(net);
  assert(event.id == id);
  if (failure != NET_FAIL_NONE) {
    int expected = failure == NET_FAIL_GETFILEP ? -EBADF : failure == NET_FAIL_DUP2 ? -EMFILE : -ENFILE;
    assert(event.type == PX_NET_CLOSED && event.error == expected);
  } else {
    assert(event.type == PX_NET_CONNECTED);
    int accepted = accept(server, NULL, NULL); assert(accepted >= 0);
    assert(send(accepted, "hello", 5, 0) == 5);
    px_net_event_free(&event); event = next(net);
    assert(event.type == PX_NET_DATA && event.length == 5 && !memcmp(event.data, "hello", 5));
    assert(px_net_send(net, id, (const uint8_t *)"OK", 2, NULL, 0) == 0);
    struct px_net_event unused; assert(px_net_poll(net, &unused) == 0);
    char reply[2]; assert(recv(accepted, reply, sizeof(reply), 0) == 2 && !memcmp(reply, "OK", 2));
    close(accepted);
  }
  px_net_event_free(&event);
  px_net_destroy(net); close(server); clean();
  struct px_net_test_stats state = px_net_test_snapshot();
  assert(state.getfilep == 1);
  assert(state.putfilep == (failure == NET_FAIL_GETFILEP ? 0u : 1u));
  assert(state.adopted == (failure == NET_FAIL_NONE ? 1u : 0u));
}

static void cancel_pending_test(void)
{
  unsigned port; int server = listening(&port);
  struct px_net *net = px_net_create(); uint32_t id; assert(net);
  assert(px_net_connect(net, "localhost", port, false, 1000, &id) == 0);
  wait_workers();
  assert(px_net_test_snapshot().pending == 1 && px_net_test_snapshot().adopted == 0);
  px_net_destroy(net); close(server); clean();
}

static void *departing_vm(void *unused)
{
  (void)unused; px_net_test_group(2);
  struct px_net *net = px_net_create(); uint32_t id; assert(net);
  for (unsigned i = 0; i < 4; ++i)
    assert(px_net_connect(net, "held.invalid", 1, false, 1000, &id) == 0);
  assert(px_net_connect(net, "held.invalid", 1, false, 1000, &id) == -EBUSY);
  px_net_destroy(net); return NULL;
}

static void owner_exit_test(enum px_net_test_failure failure)
{
  if (failure != NET_FAIL_NONE) {
    struct px_net *net = px_net_create(); uint32_t id; assert(net);
    px_net_test_fail(failure);
    for (unsigned i = 0; i < 12; ++i)
      assert(px_net_connect(net, "localhost", 1, false, 1000, &id) ==
             (failure == NET_FAIL_TASK_RAW ? -1 : -EAGAIN));
    px_net_destroy(net); clean(); px_net_test_fail(NET_FAIL_NONE);
  }
  px_net_test_hold_dns(true);
  pthread_t vm; assert(pthread_create(&vm, NULL, departing_vm, NULL) == 0);
  assert(pthread_join(vm, NULL) == 0); /* VM 发起线程已退出，DNS 仍未返回。 */
  for (unsigned i = 0; i < 1000 && px_net_test_snapshot().dns_entered != 4; ++i) sleep_ms(1);
  struct px_net_test_stats state = px_net_test_snapshot();
  assert(state.dns_entered == 4 && state.started == 4 && state.finished == 0);
  px_net_test_hold_dns(false); clean();
  /* 迟到 DNS 真实释放了四个名额，新的 VM 可以再次全部占用。 */
  px_net_test_hold_dns(true);
  assert(pthread_create(&vm, NULL, departing_vm, NULL) == 0);
  assert(pthread_join(vm, NULL) == 0);
  px_net_test_hold_dns(false); clean();
  assert(px_net_test_snapshot().started == 8 && px_net_test_snapshot().finished == 8);
}

int main(int argc, char **argv)
{
  assert(argc == 2);
  if (!strcmp(argv[1], "transfer")) transfer_test(NET_FAIL_NONE);
  else if (!strcmp(argv[1], "getfilep")) transfer_test(NET_FAIL_GETFILEP);
  else if (!strcmp(argv[1], "dup2")) transfer_test(NET_FAIL_DUP2);
  else if (!strcmp(argv[1], "import")) transfer_test(NET_FAIL_IMPORT);
  else if (!strcmp(argv[1], "pending_cancel")) cancel_pending_test();
  else if (!strcmp(argv[1], "owner_exit")) owner_exit_test(NET_FAIL_NONE);
  else if (!strcmp(argv[1], "launch_fail")) owner_exit_test(NET_FAIL_TASK);
  else if (!strcmp(argv[1], "launch_raw_fail")) owner_exit_test(NET_FAIL_TASK_RAW);
  else assert(!"unknown scenario");
  printf("independent net worker %s passed\n", argv[1]); return 0;
}
