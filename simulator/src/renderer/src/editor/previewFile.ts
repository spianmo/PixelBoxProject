import { isImageFile } from './imageFile'
import { isModelFile } from './modelFile'

/** 独立只读预览页签不创建 Monaco 模型,也不显示文本编码/光标状态。 */
export function isPreviewFile(path: string): boolean {
  return isImageFile(path) || isModelFile(path)
}
