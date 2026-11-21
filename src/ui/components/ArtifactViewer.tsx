import { useEffect, useRef, useState } from 'react'
import {
  type ArtifactOpenDetail,
  currentTheme,
  frameDoc,
  newFrameToken,
  OPEN_EVENT,
  registerFrame,
  SANDBOX,
} from '../artifacts.js'
import { Modal } from './Modal.js'

/**
 * The full view of an artifact: the same HTML in a frame the size of the
 * window, with `data-view="full"` so the page can show more than its card
 * does. Mounted once; any card's Open button reaches it through a window
 * event, because the cards are built outside React (see src/ui/artifacts.ts).
 */
export function ArtifactViewer() {
  const [open, setOpen] = useState<ArtifactOpenDetail | null>(null)
  useEffect(() => {
    const onOpen = (e: Event) => setOpen((e as CustomEvent<ArtifactOpenDetail>).detail)
    window.addEventListener(OPEN_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_EVENT, onOpen)
  }, [])
  if (!open) return null
  return (
    <Modal
      title={open.title}
      className="artifact-full"
      badge={<span className="artifact-tag">{open.owner ? 'drawn by the agent' : 'artifact'}</span>}
      onClose={() => setOpen(null)}
    >
      <FullFrame detail={open} onEscape={() => setOpen(null)} />
    </Modal>
  )
}

function FullFrame({ detail, onEscape }: { detail: ArtifactOpenDetail; onEscape: () => void }) {
  // Focus lands in the frame, whose keys never reach the Modal's Escape
  // handler; the frame forwards Escape instead.
  const onEsc = useRef(onEscape)
  onEsc.current = onEscape
  const ref = useRef<HTMLIFrameElement>(null)
  // The document is built once per open: the theme after that arrives by
  // message, like the cards', so a flip doesn't reload the page under you.
  const [token] = useState(newFrameToken)
  const [doc] = useState(() => frameDoc(detail.html, 'full', currentTheme(), detail.box, token))
  useEffect(() => {
    const frame = ref.current
    if (!frame) return
    return registerFrame({
      frame,
      token,
      owner: detail.owner,
      index: detail.index,
      title: detail.title,
      view: 'full',
      onEscape: () => onEsc.current(),
    })
  }, [detail, token])
  return (
    <iframe
      ref={ref}
      className="artifact-full-frame"
      title={detail.title}
      sandbox={SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={doc}
    />
  )
}
