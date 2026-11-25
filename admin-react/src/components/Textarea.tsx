import type { TextareaHTMLAttributes } from 'react'
import { inputClass } from './Field'

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>

export function Textarea({ className = '', ...rest }: TextareaProps) {
  return <textarea {...rest} className={`${inputClass} min-h-24 resize-y ${className}`} />
}
