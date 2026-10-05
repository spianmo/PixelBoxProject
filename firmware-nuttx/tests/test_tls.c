#define _POSIX_C_SOURCE 200809L
#include "pixelbox_tls.h"
#include <arpa/inet.h>
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

static time_t test_clock = (time_t)-1;
time_t px_test_tls_time(time_t *out)
{
  time_t now = test_clock == (time_t)-1 ? time(NULL) : test_clock;
  if (out) *out = now;
  return now;
}

static uint64_t milliseconds(void)
{
  struct timespec now;
  assert(clock_gettime(CLOCK_MONOTONIC, &now) == 0);
  return (uint64_t)now.tv_sec * 1000 + (unsigned)now.tv_nsec / 1000000;
}

static void nonblock(int fd)
{
  int flags = fcntl(fd, F_GETFL, 0);
  assert(flags >= 0 && fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0);
}

static void wait_io(struct px_tls *tls, int fd, uint64_t deadline)
{
  assert(milliseconds() < deadline);
  short events = px_tls_poll_events(tls);
  assert(events & (POLLIN | POLLOUT));
  struct pollfd pfd = {fd, events, 0};
  int result = poll(&pfd, 1, 50);
  assert(result >= 0 || errno == EINTR);
}

static unsigned char *read_ca(const char *path, size_t *size)
{
  FILE *file = fopen(path, "rb");
  assert(file);
  assert(fseek(file, 0, SEEK_END) == 0);
  long length = ftell(file);
  assert(length > 0 && length <= (long)PX_TLS_MAX_CA_BYTES);
  rewind(file);
  unsigned char *pem = malloc((size_t)length);
  assert(pem && fread(pem, 1, (size_t)length, file) == (size_t)length);
  fclose(file);
  *size = (size_t)length;
  return pem;
}

static unsigned descriptor_count(void)
{
  unsigned count = 0;
  for (int fd = 0; fd < 1024; ++fd) if (fcntl(fd, F_GETFD) >= 0) ++count;
  return count;
}

static void local_tests(const void *ca, size_t size, bool missing)
{
  int pair[2];
  struct px_tls *tls = (void *)(uintptr_t)1;
  assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
  assert(px_tls_create_with_ca(pair[0], "localhost", ca, size, &tls) == -EINVAL);
  assert(!tls);
  nonblock(pair[0]);
  if (missing) {
    assert(px_tls_create(pair[0], "localhost", &tls) == -ENOTSUP);
    assert(!tls);
    close(pair[0]); close(pair[1]);
    return;
  }
  assert(px_tls_create_with_ca(pair[0], "", ca, size, &tls) == -EINVAL);
  assert(px_tls_create_with_ca(pair[0], "localhost", NULL, 0, &tls) == -ENOTSUP);
  assert(px_tls_create_with_ca(pair[0], "localhost", ca, PX_TLS_MAX_CA_BYTES + 1, &tls) == -E2BIG);
  test_clock = 0;
  assert(px_tls_create_with_ca(pair[0], "localhost", ca, size, &tls) == -ETIME);
  test_clock = (time_t)-1;
  unsigned before = descriptor_count();
  for (int i = 0; i < 16; ++i) {
    assert(px_tls_create_with_ca(pair[0], "localhost", "invalid", 7, &tls) == -EINVAL);
    assert(!tls);
    assert(px_tls_create(pair[0], "localhost", &tls) == 0);
    assert(px_tls_read(tls, NULL, 0) == -ENOTCONN);
    assert(px_tls_rebind_fd(tls, pair[0]) == -ENOTCONN);
    px_tls_free(tls);
  }
  assert(descriptor_count() == before);
  struct px_tls *contexts[PX_TLS_MAX_CONTEXTS];
  for (unsigned i = 0; i < PX_TLS_MAX_CONTEXTS; ++i)
    assert(px_tls_create_with_ca(pair[0], "localhost", ca, size, &contexts[i]) == 0);
  assert(px_tls_create_with_ca(pair[0], "localhost", ca, size, &tls) == -EMFILE);
  assert(!tls);
  for (unsigned i = 0; i < PX_TLS_MAX_CONTEXTS; ++i) px_tls_free(contexts[i]);
  assert(px_tls_create_with_ca(pair[0], "localhost", ca, size, &tls) == 0);
  px_tls_free(tls);
  assert(fcntl(pair[0], F_GETFD) >= 0);
  px_tls_free(NULL);
  assert(px_tls_handshake(NULL) == -EINVAL);
  assert(px_tls_rebind_fd(NULL, pair[0]) == -EINVAL);
  close(pair[0]); close(pair[1]);
}

static int handshake(struct px_tls *tls, int fd, uint64_t deadline)
{
  int result;
  do {
    result = px_tls_handshake(tls);
    if (result == -EAGAIN) wait_io(tls, fd, deadline);
  } while (result == -EAGAIN);
  return result;
}

static void check_echo(struct px_tls *tls, int fd, uint64_t deadline)
{
  unsigned char output[12345], input[12000];
  for (unsigned i = 0; i < sizeof(output); ++i) output[i] = (unsigned char)(i % 251);
  for (size_t offset = 0; offset < sizeof(output);) {
    ssize_t n = px_tls_write(tls, output + offset, sizeof(output) - offset);
    if (n == -EAGAIN) { wait_io(tls, fd, deadline); continue; }
    assert(n > 0 && n <= PX_TLS_WRITE_BYTES);
    offset += (size_t)n;
  }
  size_t offset = 0;
  while (offset < sizeof(input)) {
    ssize_t n = px_tls_read(tls, input + offset, offset ? sizeof(input) - offset : 7);
    if (n == -EAGAIN) { wait_io(tls, fd, deadline); continue; }
    assert(n > 0);
    offset += (size_t)n;
    if (offset == 7) assert(px_tls_pending(tls));
  }
  for (unsigned i = 0; i < sizeof(input); ++i) assert(input[i] == (unsigned char)(i % 239));
  ssize_t n;
  do {
    n = px_tls_read(tls, input, sizeof(input));
    if (n == -EAGAIN) wait_io(tls, fd, deadline);
  } while (n == -EAGAIN);
  assert(n == 0 && px_tls_read(tls, input, 1) == 0);
  assert(px_tls_write(tls, output, 1) == -EPIPE);
  assert(px_tls_rebind_fd(tls, fd) == -EPIPE);
}

static void check_truncated(struct px_tls *tls, int fd, uint64_t deadline)
{
  unsigned char buffer[20];
  size_t total = 0;
  ssize_t n;
  do {
    n = px_tls_read(tls, buffer, sizeof(buffer));
    if (n == -EAGAIN) wait_io(tls, fd, deadline);
    else if (n > 0) total += (size_t)n;
  } while (n > 0 || n == -EAGAIN);
  assert(total == 7 && n == -ECONNRESET);
  assert(px_tls_read(tls, buffer, 1) == -ECONNRESET);
  assert(px_tls_rebind_fd(tls, fd) == -ECONNRESET);
}

static void check_pressure(struct px_tls *tls, int fd, uint64_t deadline)
{
  unsigned char block[PX_TLS_WRITE_BYTES];
  memset(block, 0x5a, sizeof(block));
  size_t total = 0;
  bool retried = false;
  while (total < 1024u * 1024u) {
    ssize_t n = px_tls_write(tls, block, sizeof(block));
    if (n == -EAGAIN) {
      retried = true;
      assert(px_tls_rebind_fd(tls, fd) == -EBUSY);
      block[0] ^= 1;
      assert(px_tls_write(tls, block, sizeof(block)) == -EBUSY);
      block[0] ^= 1;
      unsigned char ch;
      assert(px_tls_read(tls, &ch, 1) == -EAGAIN);
      wait_io(tls, fd, deadline);
      continue;
    }
    assert(n > 0 && n <= (ssize_t)sizeof(block));
    total += (size_t)n;
  }
  assert(retried);
  unsigned char ack = 0;
  ssize_t n;
  do {
    n = px_tls_read(tls, &ack, 1);
    if (n == -EAGAIN) wait_io(tls, fd, deadline);
  } while (n == -EAGAIN);
  assert(n == 1 && ack == 'K');
}

int main(int argc, char **argv)
{
  assert(argc == 4);
  const char *scenario = argv[1];
  assert(px_tls_available());
  size_t ca_size;
  unsigned char *ca = read_ca(argv[3], &ca_size);
  if (!strcmp(scenario, "default_ok") || !strcmp(scenario, "default_bad")) {
    int pair[2];
    struct px_tls *tls = NULL;
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    nonblock(pair[0]);
    int expected = !strcmp(scenario, "default_ok") ? 0 : -EINVAL;
    assert(px_tls_create(pair[0], "localhost", &tls) == expected);
    assert(expected ? !tls : !!tls);
    px_tls_free(tls);
    close(pair[0]); close(pair[1]); free(ca);
    printf("PASS %s\n", scenario);
    return 0;
  }
  if (!strcmp(scenario, "local") || !strcmp(scenario, "missing")) {
    local_tests(ca, ca_size, !strcmp(scenario, "missing"));
    free(ca);
    printf("PASS %s\n", scenario);
    return 0;
  }
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  assert(fd >= 0);
  struct sockaddr_in address = {.sin_family = AF_INET, .sin_port = htons((unsigned short)atoi(argv[2]))};
  assert(inet_pton(AF_INET, "127.0.0.1", &address.sin_addr) == 1);
  assert(connect(fd, (struct sockaddr *)&address, sizeof(address)) == 0);
  nonblock(fd);
  if (!strcmp(scenario, "pressure")) {
    int bytes = 1024;
    assert(setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &bytes, sizeof(bytes)) == 0);
  }
  struct px_tls *tls;
  const char *hostname = !strcmp(scenario, "hostname") ? "other.invalid" : "localhost";
  if (!strcmp(scenario, "default_echo")) assert(px_tls_create(fd, hostname, &tls) == 0);
  else assert(px_tls_create_with_ca(fd, hostname, ca, ca_size, &tls) == 0);
  free(ca);
  uint64_t deadline = milliseconds() + 15000;
  if (!strcmp(scenario, "stall")) {
    uint64_t started = milliseconds();
    assert(px_tls_handshake(tls) == -EAGAIN);
    assert(milliseconds() - started < 500);
    assert(px_tls_poll_events(tls) & POLLIN);
    px_tls_free(tls);
    assert(fcntl(fd, F_GETFD) >= 0);
    close(fd);
    puts("PASS stall");
    return 0;
  }
  if (!strcmp(scenario, "clock_back")) test_clock = 1704067200;
  if (!strcmp(scenario, "clock_forward")) test_clock = time(NULL) + 31536000;
  if (!strcmp(scenario, "clock_lost")) test_clock = 0;
  int result = handshake(tls, fd, deadline);
  if (!strcmp(scenario, "hostname") || !strcmp(scenario, "wrong_ca") ||
      !strcmp(scenario, "expired") || !strcmp(scenario, "future") ||
      !strcmp(scenario, "clock_back") || !strcmp(scenario, "clock_forward")) {
    if (result != -EACCES) fprintf(stderr, "unexpected handshake result %d\n", result);
    assert(result == -EACCES);
    assert(px_tls_rebind_fd(tls, fd) == -EACCES);
  } else if (!strcmp(scenario, "clock_lost")) assert(result == -ETIME);
  else {
    if (result) fprintf(stderr, "unexpected handshake result %d\n", result);
    assert(result == 0);
    assert(px_tls_handshake(tls) == 0);
    if (!strcmp(scenario, "rebind")) {
      assert(px_tls_rebind_fd(tls, -1) == -EINVAL);
      int closed = dup(fd); assert(closed >= 0); close(closed);
      assert(px_tls_rebind_fd(tls, closed) == -EBADF);
      int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
      assert(px_tls_rebind_fd(tls, pair[0]) == -EINVAL); /* 新 fd 必须非阻塞。 */
      close(pair[0]); close(pair[1]);
      unsigned before = descriptor_count();
      int original = fd;
      fd = dup(original); assert(fd >= 0 && fd != original);
      assert(close(original) == 0);
      assert(fcntl(original, F_GETFD) == -1 && errno == EBADF);
      assert(px_tls_rebind_fd(tls, fd) == 0);
      assert(descriptor_count() == before);
      /* 已完成握手的会话迁移后仍双向校验真实加密字节和 close_notify。 */
      check_echo(tls, fd, deadline);
    }
    else if (!strcmp(scenario, "echo") || !strcmp(scenario, "default_echo")) check_echo(tls, fd, deadline);
    else if (!strcmp(scenario, "truncated")) check_truncated(tls, fd, deadline);
    else if (!strcmp(scenario, "pressure")) check_pressure(tls, fd, deadline);
    else assert(!"unknown scenario");
  }
  px_tls_free(tls);
  assert(fcntl(fd, F_GETFD) >= 0);
  close(fd);
  printf("PASS %s\n", scenario);
  return 0;
}
