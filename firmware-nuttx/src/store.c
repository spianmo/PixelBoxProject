/* 开发热推送存储：限定命名空间、流式SHA256、失败回滚，绝不删除现有current补救。 */
#ifdef __APPLE__
#define _DARWIN_C_SOURCE 1
#endif
#ifdef __NuttX__
#include <nuttx/config.h>
#endif
#include "pixelbox_store.h"
#include "pixelbox_sha256.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#ifndef PATH_MAX
#define PATH_MAX 512
#endif
struct stored_file {char path[PX_STORE_MAX_PATH+1];size_t size;uint8_t digest[32];};
struct px_store {int root,staging;char path[PATH_MAX];struct stored_file *files;size_t count;bool verified;};
static int error(void){return -(errno?errno:EIO);}
static int sync_file(int fd){int result;do{result=fsync(fd);}while(result<0&&errno==EINTR);return result<0?error():0;}
static int sync_directory(int fd)
{int result=sync_file(fd);return result==-EINVAL||result==-ENOTSUP||result==-ENOSYS?0:result;}
bool px_store_valid_path(const char *path)
{
  if(!path||!*path||strlen(path)>PX_STORE_MAX_PATH||path[0]=='/'||!strcmp(path,"manifest.json"))return false;
  const char *segment=path;
  for(const unsigned char *p=(const unsigned char *)path;;++p){
    if(*p&&(*p<32||*p==127||*p=='\\'||*p==':'))return false;
    if(!*p||*p=='/'){
      size_t size=(const char *)p-segment;
      if(!size||(size==1&&segment[0]=='.')||(size==2&&segment[0]=='.'&&segment[1]=='.'))return false;
      if(!*p)break;segment=(const char *)p+1;
    }
  }
  return true;
}
static int remove_at(int parent,const char *name,unsigned depth)
{
  if(depth>32)return -ELOOP;struct stat status;
  if(fstatat(parent,name,&status,AT_SYMLINK_NOFOLLOW)<0)return errno==ENOENT?0:error();
  if(!S_ISDIR(status.st_mode))return unlinkat(parent,name,0)<0?error():0;
  int fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(fd<0)return error();
  DIR *directory=fdopendir(fd);if(!directory){int result=error();close(fd);return result;}
  int result=0;struct dirent *entry;
  while((entry=readdir(directory))!=NULL){
    if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
    result=remove_at(fd,entry->d_name,depth+1);if(result)break;
  }
  closedir(directory);if(!result&&unlinkat(parent,name,AT_REMOVEDIR)<0)result=error();return result;
}
static int ensure_root(const char *root)
{
  if(!root||root[0]!='/'||strlen(root)>=PATH_MAX)return -EINVAL;
  char path[PATH_MAX];strcpy(path,root);
  for(char *p=path+1;;++p)if(*p=='/'||!*p){
    char saved=*p;*p=0;
    if(mkdir(path,0700)<0&&errno!=EEXIST)return error();
    struct stat status;if(stat(path,&status)<0)return error();if(!S_ISDIR(status.st_mode))return -ENOTDIR;
    *p=saved;if(!saved)break;
  }
  return 0;
}
struct px_store *px_store_open(const char *root)
{
  int result=ensure_root(root);if(result){errno=-result;return NULL;}
  struct px_store *store=calloc(1,sizeof(*store));if(!store)return NULL;
  store->root=store->staging=-1;
  if(!realpath(root,store->path)){free(store);return NULL;}
  store->root=open(store->path,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  if(store->root<0){free(store);return NULL;}
  struct stat current,previous;
  if(fstatat(store->root,"current",&current,AT_SYMLINK_NOFOLLOW)<0&&errno==ENOENT&&
     fstatat(store->root,"prev",&previous,AT_SYMLINK_NOFOLLOW)==0&&S_ISDIR(previous.st_mode)){
    if(renameat(store->root,"prev",store->root,"current")<0){int saved=errno;px_store_close(store);errno=saved;return NULL;}
    (void)sync_directory(store->root);
  }
  return store;
}
void px_store_close(struct px_store *store)
{if(store){if(store->staging>=0)close(store->staging);if(store->root>=0)close(store->root);free(store->files);free(store);}}
/* 不使用字符串拼接打开不可信包路径；每个中间目录都拒绝符号链接。 */
static int open_package_file(int parent,const char *path,int flags,bool create)
{
  char copy[PX_STORE_MAX_PATH+1];strcpy(copy,path);int directory=dup(parent);if(directory<0)return error();
  char *part=copy;
  for(char *slash=strchr(part,'/');slash;slash=strchr(part,'/')){
    *slash=0;
    if(create&&mkdirat(directory,part,0700)<0&&errno!=EEXIST){int result=error();close(directory);return result;}
    int next=openat(directory,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
    if(next<0){int result=error();close(directory);return result;}
    close(directory);directory=next;part=slash+1;
  }
  int fd=openat(directory,part,flags|O_NOFOLLOW,0600);int result=fd<0?error():fd;close(directory);return result;
}
static int write_all(int fd,const void *input,size_t length)
{
  const uint8_t *data=input;
  while(length){ssize_t written=write(fd,data,length);if(written<0&&errno==EINTR)continue;
    if(written<=0)return written<0?error():-EIO;data+=written;length-=(size_t)written;}
  return 0;
}
int px_store_abort(struct px_store *store)
{
  if(!store)return -EINVAL;if(store->staging>=0){close(store->staging);store->staging=-1;}
  free(store->files);store->files=NULL;store->count=0;store->verified=false;return remove_at(store->root,"staging",0);
}
int px_store_begin(struct px_store *store,const char *manifest,const char *entry,const struct px_store_file *files,size_t count)
{
  if(!store||!manifest||!files||!count||count>PX_STORE_MAX_FILES||!px_store_valid_path(entry)||strlen(manifest)>PX_STORE_MANIFEST_BYTES)return -EINVAL;
  size_t total=0;bool has_entry=false;
  for(size_t i=0;i<count;++i){
    if(!px_store_valid_path(files[i].path)||files[i].size>PX_STORE_FILE_BYTES||files[i].size>PX_STORE_TOTAL_BYTES-total)return -EINVAL;
    total+=files[i].size;if(!strcmp(files[i].path,entry))has_entry=true;
    for(size_t j=0;j<i;++j)if(!strcmp(files[i].path,files[j].path))return -EINVAL;
  }
  if(!has_entry)return -EINVAL;
  int result=px_store_abort(store);if(result)return result;
  store->files=calloc(count,sizeof(*store->files));if(!store->files)return -ENOMEM;store->count=count;
  if(mkdirat(store->root,"staging",0700)<0){result=error();goto fail;}
  store->staging=openat(store->root,"staging",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);
  if(store->staging<0){result=error();goto fail;}
  for(size_t i=0;i<count;++i){
    strcpy(store->files[i].path,files[i].path);store->files[i].size=files[i].size;memcpy(store->files[i].digest,files[i].sha256,32);
    int fd=open_package_file(store->staging,files[i].path,O_WRONLY|O_CREAT|O_EXCL,true);
    if(fd<0){result=fd;goto fail;}result=sync_file(fd);close(fd);if(result)goto fail;
  }
  int manifest_fd=openat(store->staging,"manifest.json",O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0600);
  if(manifest_fd<0){result=error();goto fail;}
  result=write_all(manifest_fd,manifest,strlen(manifest));if(!result)result=sync_file(manifest_fd);close(manifest_fd);
  if(!result)result=sync_directory(store->staging);if(!result)return 0;
fail:
  (void)px_store_abort(store);return result;
}
int px_store_write(struct px_store *store,const char *path,size_t offset,const void *data,size_t length)
{
  if(!store||store->staging<0||!px_store_valid_path(path)||(!data&&length)||length>PX_STORE_CHUNK_BYTES)return -EINVAL;
  const struct stored_file *file=NULL;for(size_t i=0;i<store->count;++i)if(!strcmp(store->files[i].path,path)){file=&store->files[i];break;}
  if(!file||offset>file->size||length>file->size-offset)return -EINVAL;
  int fd=open_package_file(store->staging,path,O_WRONLY,false);if(fd<0)return fd;
  int result=lseek(fd,(off_t)offset,SEEK_SET)<0?error():write_all(fd,data,length);
  if(!result)result=sync_file(fd);close(fd);store->verified=false;return result;
}
int px_store_verify(struct px_store *store)
{
  if(!store||store->staging<0)return -EINVAL;
  uint8_t bytes[4096],digest[32];store->verified=false;
  for(size_t i=0;i<store->count;++i){
    const struct stored_file *file=&store->files[i];int fd=open_package_file(store->staging,file->path,O_RDONLY,false);if(fd<0)return fd;
    struct stat status;int result=fstat(fd,&status)<0?error():0;
    if(!result&&(!S_ISREG(status.st_mode)||status.st_size<0||(uint64_t)status.st_size!=file->size))result=-EBADMSG;
    struct px_sha256_state hash;px_sha256_init(&hash);
    while(!result){ssize_t count=read(fd,bytes,sizeof(bytes));if(count<0&&errno==EINTR)continue;
      if(count<0){result=error();break;}if(!count)break;px_sha256_update(&hash,bytes,(size_t)count);}
    close(fd);if(result)return result;px_sha256_final(&hash,digest);if(memcmp(digest,file->digest,32))return -EBADMSG;
  }
  store->verified=true;return 0;
}
int px_store_commit(struct px_store *store)
{
  if(!store||store->staging<0)return -EINVAL;
  int result=px_store_verify(store);if(result)return result;
  result=sync_directory(store->staging);if(result)return result;
  result=remove_at(store->root,"prev",0);if(result)return result;
  struct stat status;bool had_current=fstatat(store->root,"current",&status,AT_SYMLINK_NOFOLLOW)==0;
  if(had_current&&!S_ISDIR(status.st_mode))return -EINVAL;
  if(had_current&&renameat(store->root,"current",store->root,"prev")<0)return error();
  if(renameat(store->root,"staging",store->root,"current")<0){
    result=error();if(had_current&&renameat(store->root,"prev",store->root,"current")<0)return -EIO;
    (void)sync_directory(store->root);return result;
  }
  close(store->staging);store->staging=-1;free(store->files);store->files=NULL;store->count=0;store->verified=false;
  return sync_directory(store->root);
}
int px_store_current_root(struct px_store *store,char *out,size_t capacity)
{
  if(!store||!out||!capacity)return -EINVAL;struct stat status;
  if(fstatat(store->root,"current",&status,AT_SYMLINK_NOFOLLOW)<0)return error();if(!S_ISDIR(status.st_mode))return -EINVAL;
  int size=snprintf(out,capacity,"%s/current",store->path);return size<0||(size_t)size>=capacity?-ENAMETOOLONG:0;
}
int px_store_manifest(struct px_store *store,char **out)
{
  if(!store||!out)return -EINVAL;*out=NULL;
  int current=openat(store->root,"current",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(current<0)return error();
  int fd=openat(current,"manifest.json",O_RDONLY|O_NOFOLLOW);int result=fd<0?error():0;close(current);if(result)return result;
  struct stat status;
  if(fstat(fd,&status)<0){result=error();close(fd);return result;}
  if(!S_ISREG(status.st_mode)||status.st_size<0||status.st_size>PX_STORE_MANIFEST_BYTES){close(fd);return -EFBIG;}
  size_t size=(size_t)status.st_size;char *text=malloc(size+1);if(!text){close(fd);return -ENOMEM;}
  for(size_t offset=0;offset<size;){ssize_t count=read(fd,text+offset,size-offset);if(count<0&&errno==EINTR)continue;
    if(count<=0){result=count<0?error():-EIO;break;}offset+=(size_t)count;}
  close(fd);if(result){free(text);return result;}text[size]=0;*out=text;return 0;
}
