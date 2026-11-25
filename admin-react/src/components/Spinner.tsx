export function Spinner({ label = 'Memuat…', className = '' }: { label?: string; className?: string }) {
  return (
    <span role="status" aria-label={label} className={`inline-flex items-center gap-2 text-sm text-muted ${className}`}>
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-accent" />
      {label}
    </span>
  )
}
