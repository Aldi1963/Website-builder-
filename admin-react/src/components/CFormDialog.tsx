import { useEffect, useState, type FormEvent } from 'react'
import { Modal } from './Modal'
import { Field, inputClass } from './Field'
import { Textarea } from './Textarea'

export interface CFormField {
  name: string
  label: string
  type?: 'text' | 'number' | 'textarea'
  value?: string | number
  min?: number
  required?: boolean
  help?: string
  rows?: number
}

export type CFormValues = Record<string, string | number>

interface CFormDialogProps {
  open: boolean
  title: string
  fields: CFormField[]
  /** Nilai awal per field; bila tidak ada, dipakai field.value, else ''. */
  values?: Record<string, string | number | undefined>
  submitLabel?: string
  saving?: boolean
  onSubmit: (values: CFormValues) => void
  onCancel: () => void
}

/** Dialog form generik — padanan formDialog di admin.js lama (§0.7 SPEC).
    Semantik pengumpulan dipertahankan: input number dikumpulkan sebagai
    Number(nilai) sehingga string kosong menjadi 0; validasi klien hanya
    atribut required/min HTML, selebihnya di handler pemanggil. */
export function CFormDialog({
  open,
  title,
  fields,
  values,
  submitLabel = 'Simpan',
  saving = false,
  onSubmit,
  onCancel,
}: CFormDialogProps) {
  const [state, setState] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    const next: Record<string, string> = {}
    for (const f of fields) {
      const v = values && values[f.name] !== undefined ? values[f.name] : (f.value ?? '')
      next[f.name] = String(v)
    }
    setState(next)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const out: CFormValues = {}
    for (const f of fields) {
      const raw = state[f.name] ?? ''
      out[f.name] = f.type === 'number' ? Number(raw) : raw
    }
    onSubmit(out)
  }

  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-50"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={() => {
              // Kirim lewat form agar validasi required/min HTML jalan.
              (document.getElementById('cform-dialog-form') as HTMLFormElement | null)?.requestSubmit()
            }}
            disabled={saving}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {saving ? 'Menyimpan…' : submitLabel}
          </button>
        </>
      }
    >
      <form id="cform-dialog-form" onSubmit={handleSubmit} className="space-y-4">
        {fields.map((f) => (
          <Field key={f.name} label={f.label} htmlFor={`cform-${f.name}`} hint={f.help} required={f.required}>
            {f.type === 'textarea' ? (
              <Textarea
                id={`cform-${f.name}`}
                rows={f.rows || 3}
                value={state[f.name] ?? ''}
                onChange={(e) => setState((s) => ({ ...s, [f.name]: e.target.value }))}
              />
            ) : (
              <input
                id={`cform-${f.name}`}
                type={f.type || 'text'}
                className={inputClass}
                value={state[f.name] ?? ''}
                min={f.min}
                required={f.required}
                onChange={(e) => setState((s) => ({ ...s, [f.name]: e.target.value }))}
              />
            )}
          </Field>
        ))}
      </form>
    </Modal>
  )
}
