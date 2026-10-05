/* 复用真实 QuickJS app fixture 和 Wi-Fi/AP/DHCP 故障桩，控制端不依赖活动 VM。 */
#define PX_SERVICE_PORTAL_FIXTURE
#define main service_base_fixture_main
#include "test_service.c"
#undef main
#define PX_PORTAL_PLATFORM_ONLY
#define PX_PORTAL_TEST_CHECK_NO_VM() assert(atomic_load(&applications) == 0)
#include "test_portal_runtime.c"

void px_install_portal(JSContext *ctx, JSValue native);
static void service_portal_check_vm_start(void)
{
  struct px_portal_status status;
  assert(!px_portal_get_status(&status) && !status.wifi_owned);
  pthread_mutex_lock(&mutex); assert(!ap_active && !dhcp_active && !workers_unjoined); pthread_mutex_unlock(&mutex);
}
static void service_portal_install(JSContext *ctx, JSValue global)
{
  JSValue native = JS_NewObject(ctx); px_install_portal(ctx, native);
  assert(JS_SetPropertyStr(ctx, global, "native", native) >= 0);
}
static void service_status_line(int result)
{
  struct px_service_status service; assert(!px_service_get_status(running_service, &service));
  struct px_portal_status portal = {0}; (void)px_portal_get_status(&portal);
  pthread_mutex_lock(&key_lock); bool enabled = provisioning_enabled, active = in_provisioning;
  pthread_mutex_unlock(&key_lock);
  pthread_mutex_lock(&mutex);
  printf("{\"result\":%d,\"devdPort\":%u,\"supervising\":%s,\"appPresent\":%s,\"applications\":%u,"
    "\"generation\":%u,\"enabled\":%s,\"pending\":%s,\"owned\":%s,\"serviceOwned\":%s,"
    "\"phase\":\"%s\",\"port\":%u,\"error\":%d,\"apStarts\":%u,\"apStops\":%u,"
    "\"dhcpStarts\":%u,\"dhcpStops\":%u,\"scans\":%u,\"disconnects\":%u,\"keyEnabled\":%s,\"keyActive\":%s,"
    "\"connected\":%s,\"ssid\":\"%s\",\"workerCreates\":%u,\"workerJoins\":%u,\"workersUnjoined\":%u}\n",
    result, px_service_port(running_service), service.supervising ? "true" : "false", service.app_present ? "true" : "false",
    atomic_load(&applications), atomic_load(&generation), service.portal_enabled ? "true" : "false",
    service.portal_pending ? "true" : "false", portal.wifi_owned ? "true" : "false", service.portal_owned ? "true" : "false",
    px_portal_phase_name(portal.phase), portal.http_port, service.portal_error, ap_starts, ap_stops,
    dhcp_starts, dhcp_stops, scans, disconnects, enabled ? "true" : "false", active ? "true" : "false",
    wifi.connected ? "true" : "false", wifi.ssid, worker_creates, worker_joins, workers_unjoined);
  pthread_mutex_unlock(&mutex);
}
int main(int argc, char **argv)
{
  assert(argc == 3 || argc == 4); setvbuf(stdout, NULL, _IOLBF, 0);
  unsigned baseline = fd_count();
  char *credentials = strdup(argv[2]); assert(credentials);
  struct px_service_config config = {
    .devd = {.storage_root = argv[1], .name = "service-portal-fixture", .model = "host", .firmware = "1.0.0", .ip = "127.0.0.1"},
    .app = {.heap_limit = 8 * 1024 * 1024, .turn_timeout_ms = 1000},
    .run_app = run_app, .start_on_boot = true,
    .enable_portal = true, .portal = {.credentials_path = credentials}
  };
  assert(PX_PORTAL_DEFAULT_SESSION_MS == 180000u);
  if (argc == 4 && !strcmp(argv[3], "init-conflict")) {
    assert(!px_portal_init(&config.portal));
    assert(!px_service_create(&config, &running_service));
    assert(px_service_run(running_service) == -EALREADY);
    struct px_service_status status; assert(!px_service_get_status(running_service, &status));
    assert(!status.app_present && !status.portal_enabled && status.portal_error == -EALREADY);
    struct px_portal_status portal; assert(!px_portal_get_status(&portal));
    assert(!provisioning_enabled && !atomic_load(&applications));
    assert(!px_service_destroy(running_service) && !px_portal_shutdown());
    free(credentials); assert(fd_count() == baseline);
    puts("portal init conflict rejected without adopting another singleton"); return 0;
  }
  if (argc == 4) { assert(!strcmp(argv[3], "timeout")); config.portal.timeout_ms = 350; }
  assert(!px_service_create(&config, &running_service));
  /* create 必须复制路径，不能借用调用者的临时配置内存。 */
  memset(credentials, 'x', strlen(credentials)); free(credentials); config.portal.credentials_path = argv[2];
  pthread_t thread; assert(!pthread_create(&thread, NULL, supervisor, running_service));
  struct px_service_status status;
  do { pause_ms(1); assert(!px_service_get_status(running_service, &status)); } while (!status.portal_enabled);
  service_status_line(0);
  char *line = NULL; size_t capacity = 0;
  while (getline(&line, &capacity, stdin) > 0) {
    char command[32]; unsigned value = 0; int key_result = 0;
    int fields = sscanf(line, "%31s %u %d", command, &value, &key_result); int result = 0;
    if (!strcmp(command, "key")) {
      pthread_mutex_lock(&key_lock); assert(!pending_key.action);
      if (fields < 3 && value == PX_SYSTEM_KEY_OPEN_PROVISIONING && !provisioning_enabled) key_result = -ENOTSUP;
      pending_key = (struct px_system_key_request){.action = value, .result = key_result}; pthread_mutex_unlock(&key_lock);
    } else if (!strcmp(command, "stop")) result = px_portal_stop();
    else if (!strcmp(command, "request")) result = px_portal_request_start();
    else if (!strcmp(command, "shutdown")) px_service_request_shutdown(running_service);
    else if (!strcmp(command, "holdstart") || !strcmp(command, "holdstop") || !strcmp(command, "failstop") ||
             !strcmp(command, "scanms") || !strcmp(command, "connectms") || !strcmp(command, "failcreate")) {
      pthread_mutex_lock(&mutex);
      if (!strcmp(command, "holdstart")) hold_start = value != 0;
      else if (!strcmp(command, "holdstop")) hold_stop = value != 0;
      else if (!strcmp(command, "failstop")) fail_stop = value != 0;
      else if (!strcmp(command, "scanms")) scan_ms = value;
      else if (!strcmp(command, "failcreate")) fail_create = value;
      else connect_ms = value;
      pthread_cond_broadcast(&wake); pthread_mutex_unlock(&mutex);
    } else if (!strcmp(command, "join")) {
      assert(!px_service_get_status(running_service, &status) && !status.supervising);
      assert(!pthread_join(thread, NULL) && !supervisor_result); service_status_line(0); break;
    } else assert(!strcmp(command, "status"));
    service_status_line(result);
  }
  free(line);
  assert(!px_service_get_status(running_service, &status) && !status.supervising && !status.app_present && !status.portal_owned);
  assert(!atomic_load(&applications) && !ap_active && !dhcp_active && !provisioning_enabled && !workers_unjoined);
  assert(!px_service_destroy(running_service));
  config.start_on_boot = false;
  for (unsigned i = 0; i < 3; ++i) {
    assert(!px_service_create(&config, &running_service));
    px_service_request_shutdown(running_service); assert(!px_service_run(running_service));
    assert(!px_service_destroy(running_service));
  }
  assert(fd_count() == baseline); return 0;
}
