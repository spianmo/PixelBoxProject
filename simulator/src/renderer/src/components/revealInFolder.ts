/**
 * 「在系统文件管理器中显示」共用助手(文件树 / 编辑器页签右键菜单)
 * 文案按平台差异化:macOS=Finder / Windows=资源管理器 / 其他=文件管理器
 */
export function revealMenuLabelKey(): string {
  switch (window.api.platform) {
    case 'darwin':
      return 'common.revealInFinder'
    case 'win32':
      return 'common.revealInExplorer'
    default:
      return 'common.revealInFiles'
  }
}
