import { avatarInitial } from './BFormat'

/** Chip avatar bulat (inisial) — satu bentuk untuk semua tabel/kartu. */
export function Avatar({ name, email }: { name?: string | null; email?: string | null }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
      {avatarInitial(name, email)}
    </span>
  )
}
