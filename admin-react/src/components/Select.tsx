import type { SelectHTMLAttributes } from 'react'
import { CaretDown } from '@phosphor-icons/react'
import { inputClass } from './Field'

type SelectProps = SelectHTMLAttributes<HTMLSelectElement>

/** Select native bergaya panel (dropdown muncul menempel di bawah field,
    bukan popup layar penuh). */
export function Select({ className = '', children, ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select {...rest} className={`${inputClass} appearance-none pr-9 ${className}`}>
        {children}
      </select>
      <CaretDown
        size={16}
        className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted"
      />
    </div>
  )
}
