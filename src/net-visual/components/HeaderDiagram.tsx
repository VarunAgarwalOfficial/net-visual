export interface HeaderField {
  name: string
  bits: number
  value: string
  /** Changed since the previous hop or the previous copy of this packet. */
  changed?: boolean
  /** Not on the wire: known to the model only, shown for teaching. */
  hidden?: boolean
}

/**
 * A header drawn as in the RFCs: 32 bits per row, fields spanning their width.
 * Fields wider than 32 bits wrap onto whole rows.
 */
export function HeaderDiagram({ title, fields, note }: { title: string; fields: HeaderField[]; note?: string }) {
  const cells: { field: HeaderField; start: number; span: number; row: number; key: string }[] = []
  let pos = 0
  for (const field of fields.filter((f) => !f.hidden)) {
    let left = field.bits
    let part = 0
    while (left > 0) {
      const col = pos % 32
      const span = Math.min(left, 32 - col)
      cells.push({ field, start: col, span, row: Math.floor(pos / 32), key: `${field.name}-${part++}` })
      pos += span
      left -= span
    }
  }
  const hidden = fields.filter((f) => f.hidden)
  return (
    <figure className="font-sans text-sm">
      <figcaption className="mb-1 text-muted-foreground">{title}</figcaption>
      <div className="overflow-x-auto">
        <div className="grid min-w-[22rem] grid-cols-32 text-sm text-muted-foreground" aria-hidden>
          {Array.from({ length: 32 }, (_, i) => (
            <span key={i} className="text-center tabular-nums">
              {i % 8 === 0 ? i : ""}
            </span>
          ))}
        </div>
        <div className="grid min-w-[22rem] grid-cols-32 border-t border-l border-border" role="table" aria-label={title}>
          {cells.map((c) => (
            <div
              key={c.key}
              role="cell"
              className={
                "border-r border-b border-border px-1 py-0.5 text-center leading-tight lining " + (c.field.changed ? "bg-mark" : "")
              }
              style={{ gridColumn: `${c.start + 1} / span ${c.span}`, gridRow: c.row + 1 }}
            >
              <div className="truncate text-sm text-muted-foreground">{c.field.name}</div>
              <div className="truncate font-mono text-sm text-foreground">{c.field.value}</div>
            </div>
          ))}
        </div>
      </div>
      {hidden.length > 0 && (
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm">
          {hidden.map((f) => (
            <div key={f.name} className="contents">
              <dt className="text-muted-foreground">{f.name}</dt>
              <dd className="lining">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {note && <p className="mt-1 text-sm text-muted-foreground">{note}</p>}
    </figure>
  )
}
