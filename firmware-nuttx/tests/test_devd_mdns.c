/* 真实 devd 线程/存储/提交入口配合 mDNS 记录桩，确保接线测试绝不发出组播。 */
#include "../src/devd.c"
#include <assert.h>

struct publication {char hostname[64],ip[64],name[64],model[64],firmware[48],app[128];unsigned port;};
static pthread_mutex_t calls_lock=PTHREAD_MUTEX_INITIALIZER;
static struct publication last;
static unsigned configured,published;
static int fail_configure;

int px_mdns_configure(const char *hostname,const char *ip)
{
  pthread_mutex_lock(&calls_lock);++configured;int result=fail_configure;fail_configure=0;
  if(!result){copy_text(last.hostname,sizeof(last.hostname),hostname);copy_text(last.ip,sizeof(last.ip),ip);}
  pthread_mutex_unlock(&calls_lock);return result;
}
int px_mdns_publish_devd(const char *name,unsigned port,const char *model,const char *firmware,const char *app)
{
  pthread_mutex_lock(&calls_lock);++published;last.port=port;
  copy_text(last.name,sizeof(last.name),name);copy_text(last.model,sizeof(last.model),model);
  copy_text(last.firmware,sizeof(last.firmware),firmware);copy_text(last.app,sizeof(last.app),app);
  pthread_mutex_unlock(&calls_lock);return 0;
}
static void pause_ms(unsigned ms)
{struct timespec delay={.tv_sec=ms/1000,.tv_nsec=(long)(ms%1000)*1000000};nanosleep(&delay,NULL);}
static struct publication wait_publication(unsigned expected)
{
  uint64_t until=now_ms()+3000;
  for(;;){pthread_mutex_lock(&calls_lock);unsigned count=published;struct publication value=last;pthread_mutex_unlock(&calls_lock);
    if(count>=expected){assert(count==expected);return value;}assert(now_ms()<until);pause_ms(2);}
}
static unsigned configuration_count(void)
{pthread_mutex_lock(&calls_lock);unsigned count=configured;pthread_mutex_unlock(&calls_lock);return count;}
static void stage_app(struct px_store *store,const char *id)
{
  static const uint8_t source[]="print('mDNS fixture');";
  struct px_store_file file={.path="main.js",.size=sizeof(source)-1};
  extern void px_sha256(const uint8_t *,size_t,uint8_t[32]);
  px_sha256(source,sizeof(source)-1,file.sha256);
  char manifest[512];snprintf(manifest,sizeof(manifest),"{\"id\":\"%s\",\"name\":\"fixture\",\"version\":\"1.0.0\",\"entry\":\"main.js\"}",id);
  assert(!px_store_begin(store,manifest,"main.js",&file,1));
  assert(!px_store_write(store,"main.js",0,source,sizeof(source)-1));
}
static void real_service(const char *root)
{
  struct px_store *store=px_store_open(root);assert(store);stage_app(store,"initial.app");assert(!px_store_commit(store));px_store_close(store);
  struct px_devd_config config={.storage_root=root,.name="fixture",.model="host",.firmware="mDNS-test",.ip="127.0.0.1",.mac="00:AA:22:BB:44:55"};
  struct px_devd *service=NULL;assert(!px_devd_start(&config,&service));
  px_devd_network(service,"127.0.0.2","00:AA:22:BB:44:55",1);pause_ms(30);
  assert(!configuration_count());px_devd_stop(service);

  config.advertise=true;assert(!px_devd_start(&config,&service));
  struct publication value=wait_publication(1);
  assert(value.port==px_devd_port(service)&&value.port>0);
  assert(!strcmp(value.hostname,"pixelbox-00aa22bb4455")&&!strcmp(value.ip,"127.0.0.1"));
  assert(!strcmp(value.name,"fixture")&&!strcmp(value.model,"host")&&!strcmp(value.firmware,"mDNS-test")&&!strcmp(value.app,"initial.app"));
  for(unsigned i=0;i<8;++i)px_devd_network(service,"127.0.0.1","00:AA:22:BB:44:55",i);
  pause_ms(30);assert(configuration_count()==1);
  px_devd_network(service,"127.0.0.2","11:22:33:44:55:66",10);value=wait_publication(2);
  assert(!strcmp(value.hostname,"pixelbox-112233445566")&&!strcmp(value.ip,"127.0.0.2"));
  px_devd_network(service,NULL,NULL,20);value=wait_publication(3);
  assert(!strcmp(value.ip,"0.0.0.0")&&!strncmp(value.hostname,"pixelbox-",9)&&strlen(value.hostname)==21);
  pthread_mutex_lock(&calls_lock);fail_configure=-ENOMEM;pthread_mutex_unlock(&calls_lock);
  px_devd_network(service,"127.0.0.3","11:22:33:44:55:66",30);value=wait_publication(4);
  assert(!strcmp(value.ip,"127.0.0.3")&&configuration_count()==5);
  px_devd_stop(service);
}
static void submitted_app(const char *root)
{
  struct px_devd service={.advertise=true,.listener=1,.port=32123,.owner=7,.push_token=1,.push_storage_started=true};
  assert(!pthread_mutex_init(&service.mutex,NULL));
  copy_text(service.boot,sizeof(service.boot),"1234567890abcdef");copy_text(service.name,sizeof(service.name),"submit-fixture");
  copy_text(service.session,sizeof(service.session),"session");
  service.runtime=JS_NewRuntime();assert(service.runtime);service.json=JS_NewContext(service.runtime);assert(service.json);
  service.store=px_store_open(root);assert(service.store);
  refresh_app(&service);refresh_mdns(&service);struct publication value=wait_publication(5);assert(!value.app[0]);
  stage_app(service.store,"new.current.app");
  JSValue params=JS_NewObject(service.json);text_property(service.json,params,"session","session");
  struct client client={.socket=1,.serial=7};push_end(&service,&client,1,params);JS_FreeValue(service.json,params);
  assert(client.tx_count==1);struct px_devd_action action;assert(px_devd_take_action(&service,&action)==1&&action.type==PX_DEVD_PUSH_COMMIT);
  px_devd_release_push(&service,action.token);px_devd_action_free(&action);
  /* 正式循环在请求处理后刷新；TXT 必须是刚提交的 manifest.id。 */
  refresh_mdns(&service);value=wait_publication(6);assert(value.port==32123&&!strcmp(value.app,"new.current.app"));
  for(struct output *item=client.head;item;){struct output *next=item->next;free(item->bytes);free(item);item=next;}
  px_store_close(service.store);JS_FreeContext(service.json);JS_FreeRuntime(service.runtime);pthread_mutex_destroy(&service.mutex);
}
int main(int argc,char **argv)
{
  assert(argc==3);real_service(argv[1]);submitted_app(argv[2]);
  puts("devd mDNS 接线通过：默认静默、实际端口、MAC hostname、IP/断网、重复状态、失败重试、真实应用提交 TXT");return 0;
}
