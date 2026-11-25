/* Grafik SVG ringan pengganti Chart.js (tanpa dependensi baru).
   Dipakai Dashboard (line 2 dataset + doughnut) dan Penggunaan (line 3
   dataset). Palet sama seperti chartColors di admin.js lama. */

export const CHART_COLORS = {
  blue: '#2563eb',
  green: '#16a34a',
  amber: '#d97706',
  red: '#dc2626',
  slate: '#64748b',
  teal: '#0d9488',
} as const

export interface LineDataset {
  label: string
  data: number[]
  color: string
  fill?: boolean
}

interface LineChartProps {
  labels: string[]
  datasets: LineDataset[]
  height?: number
}

/** Line chart SVG: sumbu Y mulai 0, tick bulat, legenda di bawah. */
export function BLineChart({ labels, datasets, height = 300 }: LineChartProps) {
  const W = 640
  const H = 260
  const padL = 44
  const padR = 12
  const padT = 12
  const padB = 28
  const all = datasets.flatMap((d) => d.data)
  const maxV = Math.max(0, ...all)
  const yMax = maxV <= 0 ? 1 : maxV
  const x = (i: number) =>
    labels.length <= 1
      ? padL + (W - padL - padR) / 2
      : padL + (i * (W - padL - padR)) / (labels.length - 1)
  const y = (v: number) => padT + (1 - v / yMax) * (H - padT - padB)
  const ticks = 4
  const tickVals = Array.from({ length: ticks + 1 }, (_, i) =>
    Math.round((yMax * i) / ticks),
  )

  const points = (data: number[]) => data.map((v, i) => `${x(i)},${y(v)}`).join(' ')

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height }}
        role="img"
        aria-label="Grafik garis"
      >
        {tickVals.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)">
              {t.toLocaleString('id-ID')}
            </text>
          </g>
        ))}
        {datasets.map((d) =>
          d.fill ? (
            <polygon
              key={`${d.label}-fill`}
              points={`${x(0)},${y(0)} ${points(d.data)} ${x(d.data.length - 1)},${y(0)}`}
              fill={d.color}
              fillOpacity={0.12}
            />
          ) : null,
        )}
        {datasets.map((d) => (
          <polyline
            key={d.label}
            points={points(d.data)}
            fill="none"
            stroke={d.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {datasets.map((d) =>
          d.data.map((v, i) => (
            <circle key={`${d.label}-${i}`} cx={x(i)} cy={y(v)} r={2.5} fill={d.color} />
          )),
        )}
        {labels.map((lb, i) => (
          <text
            key={lb + i}
            x={x(i)}
            y={H - 8}
            textAnchor="middle"
            fontSize={11}
            fill="var(--muted)"
          >
            {lb}
          </text>
        ))}
      </svg>
      <div className="mt-2 flex flex-wrap justify-center gap-4 text-sm text-muted">
        {datasets.map((d) => (
          <span key={d.label} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: d.color }}
            />
            {d.label}
          </span>
        ))}
      </div>
    </div>
  )
}

export interface DoughnutSlice {
  label: string
  value: number
}

/** Doughnut chart SVG + legenda di bawah (label + nilai). */
export function BDoughnut({ slices }: { slices: DoughnutSlice[] }) {
  const colors = [
    CHART_COLORS.blue,
    CHART_COLORS.green,
    CHART_COLORS.amber,
    CHART_COLORS.red,
    CHART_COLORS.slate,
    CHART_COLORS.teal,
  ]
  const total = slices.reduce((s, x) => s + x.value, 0)
  const R = 70
  const C = 2 * Math.PI * R
  let offset = 0
  return (
    <div>
      {total > 0 ? (
        <svg
          viewBox="0 0 200 200"
          style={{ width: '100%', maxWidth: 260, height: 260, margin: '0 auto', display: 'block' }}
          role="img"
          aria-label="Grafik status proyek"
        >
          <circle cx={100} cy={100} r={R} fill="none" stroke="var(--border)" strokeWidth={28} />
          {slices.map((s, i) => {
            const frac = s.value / total
            const dash = frac * C
            const el = (
              <circle
                key={s.label}
                cx={100}
                cy={100}
                r={R}
                fill="none"
                stroke={colors[i % colors.length]}
                strokeWidth={28}
                strokeDasharray={`${dash} ${C - dash}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 100 100)"
              />
            )
            offset += dash
            return el
          })}
          <text x={100} y={96} textAnchor="middle" fontSize={22} fontWeight={700} fill="var(--text)">
            {total.toLocaleString('id-ID')}
          </text>
          <text x={100} y={116} textAnchor="middle" fontSize={12} fill="var(--muted)">
            proyek
          </text>
        </svg>
      ) : (
        <p className="py-12 text-center text-sm text-muted">Belum ada data.</p>
      )}
      <div className="mt-2 flex flex-wrap justify-center gap-4 text-sm text-muted">
        {slices.map((s, i) => (
          <span key={s.label} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: colors[i % colors.length] }}
            />
            {s.label} ({s.value.toLocaleString('id-ID')})
          </span>
        ))}
      </div>
    </div>
  )
}
