/* Dialog form generik — padanan formDialog di admin.js lama (§0.7 SPEC).
   Field number dikumpulkan sebagai Number(nilai); string kosong menjadi 0,
   sama seperti perilaku lama (SPEC §3 Q16, dipertahankan). */

import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { Field, inputClass } from './Field'
import { Textarea } from './Textarea'

export interface BFormField {
  name: string
  label: string
  type?: string
  value?: string | number
  min?: number
  required?: boolean
  help?: string
  rows?: number
}

export type BFormValues = Record<string, string | number>

interface BFormDialogProps {
  open: boolean
  title: string
  fields: BFormField[]
  values?: Record<string, string | number | null | undefined>
  onSubmit: (vals: BFormValues | null) => void
}

export function BFormDialog({ open, title, fields, values, onSubmit }: BFormDialogProps) {
  const [state, setState] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!open) return
    const init: Record<string, string> = {}
    for (const f of fields) {
      const v = values && values[f.name] !== undefined && values[f.name] !== null ? values[f.name] : (f.value ?? '')
      init[f.name] = String(v)
    }
    setState(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const save = () => {
    const out: BFormValues = {}
    for (const f of fields) {
      const raw = state[f.name] ?? ''
      out[f.name] = f.type === 'number' ? Number(raw) : raw
    }
    onSubmit(out)
  }

  return (
    <Modal
      open={open}
      onClose={() => onSubmit(null)}
      title={title}
      footer={
        <>
          <button
            type="button"
            onClick={() => onSubmit(null)}
            className="rounded-lg border border-border bg-surface px-4 py-2 text-sm font-medium hover:bg-surface-muted"
          >
            Batal
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
          >
            Simpan
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {fields.map((f) => (
          <Field key={f.name} label={f.label} htmlFor={`bform-${f.name}`} hint={f.help} required={f.required}>
            {f.type === 'textarea' ? (
              <Textarea
                id={`bform-${f.name}`}
                rows={f.rows || 3}
                value={state[f.name] ?? ''}
                onChange={(e) => setState((s) => ({ ...s, [f.name]: e.target.value }))}
              />
            ) : (
              <input
                id={`bform-${f.name}`}
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
      </div>
    </Modal>
  )
}
