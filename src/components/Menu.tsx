import { useEffect, useRef, useState, type ReactNode } from 'react'

interface MenuProps {
  /** Render the trigger button's contents; receives the open state for styling. */
  trigger: (open: boolean) => ReactNode
  /** Panel contents. Receives a `close` fn so action rows can dismiss the menu
   *  (toggles can ignore it to keep the menu open across several flips). */
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
  /** Classes for the trigger <button>. */
  triggerClassName?: string
  /** Classes for the outer positioning wrapper (e.g. `ml-auto`). */
  className?: string
  title?: string
  /** Optional data-tour anchor stamped on the wrapper (spotlight tour). */
  dataTour?: string
}

/**
 * A minimal click-outside dropdown (pattern lifted from CandidatePopup): a
 * trigger button that toggles an absolutely-positioned panel, dismissed on
 * outside-mousedown or Escape. Presentational only — callers supply the rows
 * via MenuSection / MenuItem / MenuRow.
 */
export function Menu({
  trigger,
  children,
  align = 'right',
  triggerClassName,
  className,
  title,
  dataTour,
}: MenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div ref={ref} className={['relative', className].filter(Boolean).join(' ')} data-tour={dataTour}>
      <button type="button" onClick={() => setOpen((o) => !o)} title={title} className={triggerClassName}>
        {trigger(open)}
      </button>
      {open && (
        <div
          role="menu"
          data-tour="popup"
          className={[
            'absolute z-50 mt-1 min-w-[13rem] rounded-md border border-border-strong bg-surface shadow-lg py-1',
            align === 'right' ? 'right-0' : 'left-0',
          ].join(' ')}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

/** A titled group of rows, divided from its neighbours. */
export function MenuSection({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="py-1 border-t border-border first:border-t-0 first:pt-0 last:pb-0">
      {label && (
        <p className="px-3 pb-1 text-[9px] uppercase tracking-[0.12em] text-ink-faint">{label}</p>
      )}
      {children}
    </div>
  )
}

/** A clickable action row (button, or an <a> when `href` is given). */
export function MenuItem({
  onClick,
  icon,
  children,
  disabled,
  active,
  title,
  href,
  download,
}: {
  onClick?: () => void
  icon?: ReactNode
  children: ReactNode
  disabled?: boolean
  active?: boolean
  title?: string
  href?: string
  download?: string
}) {
  const cls = [
    'w-full flex items-center gap-2 px-3 py-1.5 text-[12px] text-left transition-colors',
    active ? 'text-brand' : 'text-ink-muted',
    'hover:bg-surface-muted hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-muted',
  ].join(' ')
  const inner = (
    <>
      <span className="shrink-0 w-3 flex justify-center text-ink-faint">{icon}</span>
      <span className="flex-1">{children}</span>
    </>
  )
  if (href) {
    return (
      <a href={href} download={download} onClick={onClick} title={title} role="menuitem" className={cls}>
        {inner}
      </a>
    )
  }
  return (
    <button type="button" onClick={onClick} disabled={disabled} title={title} role="menuitem" className={cls}>
      {inner}
    </button>
  )
}

/** A non-action row: a left label with a control (select / toggle) on the right. */
export function MenuRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-[12px] text-ink-muted">
      <span>{label}</span>
      {children}
    </div>
  )
}
