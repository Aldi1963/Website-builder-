import { MagnifyingGlass } from '@phosphor-icons/react'

interface SearchInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  ariaLabel?: string
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Cari…',
  ariaLabel = 'Cari',
}: SearchInputProps) {
  return (
    <div className="relative">
      <MagnifyingGlass
        size={16}
        className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="w-full rounded-lg border border-border bg-surface py-2 pr-3 pl-9 text-sm outline-none placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
    </div>
  )
}
