import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { VscCheck, VscChevronDown, VscKebabVertical, VscSearch } from 'react-icons/vsc'
import css from './Dropdown.module.css'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  description?: string
  disabled?: boolean
}

export function filterSelectOptions<T extends string>(options: SelectOption<T>[], query: string): SelectOption<T>[] {
  const needle = query.trim().toLocaleLowerCase()
  if (needle === '') return options
  return options.filter(option => (option.label + ' ' + (option.description ?? '')).toLocaleLowerCase().includes(needle))
}

interface SelectProps<T extends string> {
  value: T
  options: SelectOption<T>[]
  onChange(value: T): void
  label: string
  className?: string
  disabled?: boolean
  searchable?: boolean
  placeholder?: string
  renderValue?: (option: SelectOption<T> | undefined) => ReactNode
}

export function Select<T extends string>({ value, options, onChange, label, className, disabled, searchable, placeholder = 'Select', renderValue }: SelectProps<T>) {
  const id = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const selected = options.find(option => option.value === value)
  const canSearch = searchable ?? options.length > 8
  const filtered = useMemo(() => filterSelectOptions(options, query), [options, query])

  const show = (): void => {
    if (disabled) return
    const selectedIndex = options.findIndex(option => option.value === value)
    setQuery('')
    setActive(Math.max(0, selectedIndex))
    setOpen(true)
  }
  const hide = (restoreFocus = false): void => {
    setOpen(false)
    setQuery('')
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus())
  }
  const choose = (option: SelectOption<T>): void => {
    if (option.disabled) return
    onChange(option.value)
    hide(true)
  }
  const move = (direction: 1 | -1): void => {
    if (filtered.length === 0) return
    let next = active
    for (let index = 0; index < filtered.length; index++) {
      next = (next + direction + filtered.length) % filtered.length
      if (!filtered[next]?.disabled) break
    }
    setActive(next)
  }
  const onMenuKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
    else if (event.key === 'Home') { event.preventDefault(); setActive(0) }
    else if (event.key === 'End') { event.preventDefault(); setActive(Math.max(0, filtered.length - 1)) }
    else if (event.key === 'Enter') { event.preventDefault(); const option = filtered[active]; if (option !== undefined) choose(option) }
    else if (event.key === 'Escape' || event.key === 'Tab') hide(event.key === 'Escape')
  }

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => { if (!rootRef.current?.contains(event.target as Node)) hide() }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])
  useEffect(() => {
    if (!open) return
    requestAnimationFrame(() => { (canSearch ? searchRef.current : listRef.current)?.focus() })
  }, [canSearch, open])
  useEffect(() => { setActive(0) }, [query])

  return <div ref={rootRef} className={[css.root, className].filter(Boolean).join(' ')}>
    <button
      ref={triggerRef}
      type="button"
      className={css.trigger}
      role="combobox"
      aria-label={label}
      aria-haspopup="listbox"
      aria-expanded={open}
      aria-controls={id}
      disabled={disabled}
      onClick={() => { open ? hide() : show() }}
      onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          show()
        }
      }}
    >
      <span>{renderValue ? renderValue(selected) : selected?.label ?? placeholder}</span><VscChevronDown aria-hidden="true" />
    </button>
    {open && <div className={css.popover}>
      {canSearch && <label className={css.search}><VscSearch aria-hidden="true" /><input ref={searchRef} value={query} onChange={event => { setQuery(event.target.value) }} onKeyDown={onMenuKeyDown} placeholder="Search" aria-label={'Search ' + label} /></label>}
      <div ref={listRef} id={id} className={css.listbox} role="listbox" tabIndex={canSearch ? -1 : 0} aria-label={label} aria-activedescendant={filtered[active] === undefined ? undefined : id + '-' + active} onKeyDown={onMenuKeyDown}>
        {filtered.length === 0 && <div className={css.noResults}>No results</div>}
        {filtered.map((option, index) => <div
          id={id + '-' + index}
          key={option.value}
          className={css.option}
          role="option"
          aria-selected={option.value === value}
          aria-disabled={option.disabled}
          data-active={index === active}
          onMouseEnter={() => { setActive(index) }}
          onMouseDown={event => { event.preventDefault() }}
          onClick={() => { choose(option) }}
        >
          <span><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
          {option.value === value && <VscCheck aria-hidden="true" />}
        </div>)}
      </div>
    </div>}
  </div>
}

export interface MenuItem {
  id: string
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separator?: boolean
  onSelect(): void
}

export function ActionMenu({ label, items, icon = <VscKebabVertical /> }: { label: string; items: MenuItem[]; icon?: ReactNode }) {
  const id = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const enabled = items.map((item, index) => item.disabled ? -1 : index).filter(index => index >= 0)
  const focusIndex = (index: number): void => { setActive(index); requestAnimationFrame(() => itemRefs.current[index]?.focus()) }
  const show = (): void => { setOpen(true); focusIndex(enabled[0] ?? 0) }
  const hide = (restoreFocus = false): void => { setOpen(false); if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus()) }

  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent): void => { if (!rootRef.current?.contains(event.target as Node)) hide() }
    document.addEventListener('mousedown', close)
    return () => { document.removeEventListener('mousedown', close) }
  }, [open])

  return <div className={css.menuRoot} ref={rootRef}>
    <button ref={triggerRef} type="button" className={css.iconTrigger} title={label} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => { open ? hide() : show() }} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); show() } }}>{icon}</button>
    {open && <div id={id} className={[css.popover, css.menu].join(' ')} role="menu" aria-label={label} onKeyDown={event => {
      const position = enabled.indexOf(active)
      if (event.key === 'ArrowDown') { event.preventDefault(); focusIndex(enabled[(position + 1) % enabled.length] ?? 0) }
      else if (event.key === 'ArrowUp') { event.preventDefault(); focusIndex(enabled[(position - 1 + enabled.length) % enabled.length] ?? 0) }
      else if (event.key === 'Escape' || event.key === 'Tab') hide(event.key === 'Escape')
    }}>
      {items.map((item, index) => <button
        ref={element => { itemRefs.current[index] = element }}
        key={item.id}
        type="button"
        role="menuitem"
        className={css.menuItem}
        data-danger={item.danger}
        data-separator={item.separator}
        disabled={item.disabled}
        tabIndex={index === active ? 0 : -1}
        onClick={() => { item.onSelect(); hide(true) }}
      >{item.icon}<span>{item.label}</span></button>)}
    </div>}
  </div>
}
