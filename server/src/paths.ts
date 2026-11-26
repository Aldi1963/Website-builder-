import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const ROOT = resolve(here, '..', '..')
export const TEMPLATE_DIR = resolve(ROOT, 'template')
export const STARTERS_DIR = resolve(ROOT, 'starters')
export const PROJECTS_DIR = join(ROOT, 'data', 'projects')
export const PREVIEW_HOST = process.env.VB_PREVIEW_HOST ?? 'preview.localhost'
export const PLATFORM_PORT = Number(process.env.PORT ?? 3000)
export const PREVIEW_PORT_BASE = Number(process.env.VB_PREVIEW_PORT_BASE ?? 4100)
export const MAX_PREVIEWS = Number(process.env.VB_MAX_PREVIEWS ?? 12)
