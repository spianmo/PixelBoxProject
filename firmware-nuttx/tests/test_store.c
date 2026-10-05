#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#include "pixelbox_store.h"
#include "pixelbox_sha256.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
static bool fail_commit;
int px_test_renameat(int oldfd,const char *old,int newfd,const char *next)
{if(fail_commit&&!strcmp(old,"staging")){fail_commit=false;errno=EIO;return -1;}return renameat(oldfd,old,newfd,next);}
static void hex(const uint8_t *bytes,char out[65])
{for(unsigned i=0;i<32;++i)sprintf(out+2*i,"%02x",bytes[i]);}
static void hashes(void)
{
  uint8_t digest[32],other[32];char value[65];px_sha256(NULL,0,digest);hex(digest,value);
  assert(!strcmp(value,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
  px_sha256((const uint8_t *)"abc",3,digest);hex(digest,value);assert(!strcmp(value,"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
  struct px_sha256_state state;px_sha256_init(&state);uint8_t data[1000];memset(data,'a',sizeof(data));
  for(unsigned i=0;i<1000;++i)px_sha256_update(&state,data,sizeof(data));px_sha256_final(&state,digest);hex(digest,value);
  assert(!strcmp(value,"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
  for(size_t size=0;size<1000;++size){px_sha256(data,size,digest);px_sha256_init(&state);
    for(size_t i=0;i<size;++i)px_sha256_update(&state,data+i,1);px_sha256_final(&state,other);assert(!memcmp(digest,other,32));}
}
static void write_files(struct px_store *store,const char *main,const uint8_t *asset,size_t size)
{
  assert(px_store_write(store,"main.js",0,main,strlen(main))==0);
  for(size_t offset=0;offset<size;){size_t n=size-offset<32768?size-offset:32768;assert(px_store_write(store,"assets/data.bin",offset,asset+offset,n)==0);offset+=n;}
}
static void check_manifest(struct px_store *store,const char *expected)
{char *value=NULL;assert(px_store_manifest(store,&value)==0&&!strcmp(value,expected));free(value);}
int main(int argc,char **argv)
{
  assert(argc==2);hashes();struct px_store *store=px_store_open(argv[1]);assert(store);
  const char *first="console.log(1)",*second="console.log(2)";
  uint8_t data[65537];for(unsigned i=0;i<sizeof(data);++i)data[i]=(uint8_t)i;
  struct px_store_file files[3]={{.path="main.js",.size=strlen(first)},{.path="assets/data.bin",.size=sizeof(data)},{.path="empty.bin",.size=0}};
  px_sha256((const uint8_t *)first,strlen(first),files[0].sha256);px_sha256(data,sizeof(data),files[1].sha256);px_sha256(NULL,0,files[2].sha256);
  const char *manifest1="{\"id\":\"test.app\",\"entry\":\"main.js\",\"version\":\"1\"}",*manifest2="{\"id\":\"test.app\",\"entry\":\"main.js\",\"version\":\"2\"}";
  const char *bad[]={"/absolute","../escape","a/../b","a//b","a/",".","manifest.json","a\\b","a:b"};
  for(unsigned i=0;i<sizeof(bad)/sizeof(*bad);++i)assert(!px_store_valid_path(bad[i]));
  assert(px_store_begin(store,manifest1,"main.js",files,3)==0);assert(px_store_verify(store)==-EBADMSG);
  assert(px_store_write(store,"undeclared",0,data,1)==-EINVAL);assert(px_store_write(store,"main.js",strlen(first),data,1)==-EINVAL);
  assert(px_store_write(store,"assets/data.bin",0,data,32769)==-EINVAL);
  write_files(store,first,data,sizeof(data));assert(px_store_verify(store)==0);assert(px_store_commit(store)==0);check_manifest(store,manifest1);
  px_sha256((const uint8_t *)second,strlen(second),files[0].sha256);
  assert(px_store_begin(store,manifest2,"main.js",files,3)==0);write_files(store,second,data,sizeof(data));
  uint8_t corrupt=99;assert(px_store_write(store,"assets/data.bin",2,&corrupt,1)==0);assert(px_store_commit(store)==-EBADMSG);check_manifest(store,manifest1);
  assert(px_store_write(store,"assets/data.bin",2,data+2,1)==0);fail_commit=true;assert(px_store_commit(store)==-EIO);check_manifest(store,manifest1);
  assert(px_store_commit(store)==0);check_manifest(store,manifest2);
  assert(px_store_begin(store,manifest2,"main.js",files,3)==0);
  int root=open(argv[1],O_RDONLY|O_DIRECTORY),stage=openat(root,"staging",O_RDONLY|O_DIRECTORY);assert(root>=0&&stage>=0);
  assert(unlinkat(stage,"main.js",0)==0);assert(symlinkat("../current/main.js",stage,"main.js")==0);
  assert(px_store_write(store,"main.js",0,"wrong",5)<0);check_manifest(store,manifest2);close(stage);
  assert(px_store_abort(store)==0);assert(faccessat(root,"staging",F_OK,0)<0);
  // 模拟旧current已移走而新current尚未落位的掉电窗口，启动必须恢复prev。
  px_store_close(store);assert(renameat(root,"current",root,"interrupted")==0);close(root);
  store=px_store_open(argv[1]);assert(store);check_manifest(store,manifest1);
  char path[1024];assert(px_store_current_root(store,path,sizeof(path))==0&&strstr(path,"/current"));
  px_store_close(store);puts("热推送存储通过：流式SHA256标准向量/32KiB块/空文件/大小与摘要、路径及符号链接拒绝、提交失败回滚、掉电窗口恢复");return 0;
}
