import { useMemo } from 'react'
import DOMPurify from 'dompurify'
import { BaseBoxShapeUtil, HTMLContainer, T, type TLShape } from 'tldraw'
import { radius } from '@wb/sdk'

export const CARD_TYPE = 'wb-card'

const URL_ATTRS = new Set(['src', 'href', 'xlink:href', 'action', 'formaction', 'srcset', 'poster', 'background'])

// Result cards come from sandboxed code: allow only inline data, never a URL that
// would make the app fetch something (that could carry data out of the sandbox).
DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
  if (URL_ATTRS.has(data.attrName.toLowerCase()) && !/^(data:image\/|#)/i.test(data.attrValue.trim())) data.keepAttr = false
})

declare module 'tldraw' {
  export interface TLGlobalShapePropsMap {
    [CARD_TYPE]: { w: number; h: number; title: string; svg: string; html: string }
  }
}

export type CardShape = TLShape<typeof CARD_TYPE>

interface CardBodyProps {
  shape: CardShape
}

/** Sanitised SVG/HTML from run_code. Scripts and event handlers are stripped. */
function CardBody({ shape }: CardBodyProps) {
  const markup = useMemo(() => {
    if (shape.props.svg) return DOMPurify.sanitize(shape.props.svg, { USE_PROFILES: { svg: true, svgFilters: true } })
    return DOMPurify.sanitize(shape.props.html, { FORBID_TAGS: ['style', 'form', 'iframe'], FORBID_ATTR: ['style'] })
  }, [shape.props.svg, shape.props.html])
  return (
    <HTMLContainer
      className="wb-glass wb-glass--strong"
      style={{ width: shape.props.w, height: shape.props.h, overflow: 'hidden', pointerEvents: 'all', display: 'flex', flexDirection: 'column' }}
    >
      {shape.props.title && <div className="wb-panel-header">{shape.props.title}</div>}
      <div className="wb-card-body" style={{ flex: 1, minHeight: 0, padding: 12, overflow: 'auto' }} dangerouslySetInnerHTML={{ __html: markup }} />
    </HTMLContainer>
  )
}

export class CardShapeUtil extends BaseBoxShapeUtil<CardShape> {
  static override type = CARD_TYPE
  static override props = { w: T.number, h: T.number, title: T.string, svg: T.string, html: T.string }

  getDefaultProps(): CardShape['props'] {
    return { w: 480, h: 320, title: '', svg: '', html: '' }
  }

  component(shape: CardShape) {
    return <CardBody shape={shape} />
  }

  getIndicatorPath(shape: CardShape) {
    const path = new Path2D()
    path.roundRect(0, 0, shape.props.w, shape.props.h, radius.lg)
    return path
  }
}
