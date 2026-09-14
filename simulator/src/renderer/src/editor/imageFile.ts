/** Chromium 可直接预览的图片格式;文件图标、打开分流和 Blob MIME 共用此表。 */
const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  apng: 'image/apng',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon'
}

export function imageMimeForPath(path: string): string | null {
  const name = path.split(/[/\\]/).pop() ?? ''
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1).toLowerCase()
  return Object.prototype.hasOwnProperty.call(IMAGE_MIME_TYPES, ext) ? IMAGE_MIME_TYPES[ext] : null
}

export function isImageFile(path: string): boolean {
  return imageMimeForPath(path) !== null
}
