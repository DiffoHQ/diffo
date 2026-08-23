import type { FileChange } from '../../shared/types.js'

function imageUrl(path: string, side: 'base' | 'head'): string {
  return `/api/file?path=${encodeURIComponent(path)}&side=${side}`
}

export function ImageDiff({ file }: { file: FileChange }) {
  const showBase = file.status !== 'added'
  const showHead = file.status !== 'deleted'
  const basePath = file.oldPath ?? file.path
  return (
    <div className="image-diff">
      {showBase && (
        <figure className="image-side image-side-base">
          <img src={imageUrl(basePath, 'base')} alt={`${basePath} (base)`} />
          <figcaption>base</figcaption>
        </figure>
      )}
      {showHead && (
        <figure className="image-side image-side-head">
          <img src={imageUrl(file.path, 'head')} alt={`${file.path} (head)`} />
          <figcaption>head</figcaption>
        </figure>
      )}
    </div>
  )
}
