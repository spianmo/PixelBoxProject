/**
 * vite `?raw` 导入声明(main 进程侧)
 * tsconfig.node.json 未引入 vite/client,此处补最小声明:
 * projectScaffold.ts 经 ?raw 内嵌 sdk/types/pixelbox.d.ts 全文,写入新建项目
 */
declare module '*?raw' {
  const content: string
  export default content
}
