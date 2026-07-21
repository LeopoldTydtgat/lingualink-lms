const SECTION_FIELD_COUNTS = [6, 5, 6, 2, 4]

export default function Loading() {
  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      {/* header */}
      <div className="max-w-6xl mx-auto flex items-center gap-3 mb-6">
        <div className="h-4 w-20 rounded bg-gray-200 animate-pulse" />
        <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* single scrolling form — one card per section */}
      <div className="max-w-6xl mx-auto space-y-8 pb-28">
        {SECTION_FIELD_COUNTS.map((fieldCount, s) => (
          <div key={s} className="card-elevated p-5 space-y-4">
            {/* section heading — accent bar + title */}
            <div className="flex items-center gap-2.5">
              <span className="block rounded-full bg-gray-200 animate-pulse"
                style={{ width: '3px', height: '18px' }} />
              <div className="h-4 w-36 rounded bg-gray-200 animate-pulse" />
            </div>
            {Array.from({ length: fieldCount }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
                <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>
        ))}

        {/* admin notes — amber */}
        <div
          className="rounded-xl border p-5 space-y-4"
          style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}
        >
          <div className="h-4 w-64 rounded animate-pulse" style={{ backgroundColor: '#fde68a' }} />
          <div className="h-3 w-24 rounded animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
          <div className="h-24 w-full rounded-lg animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-28 rounded animate-pulse mb-2" style={{ backgroundColor: '#fef3c7' }} />
                <div className="h-9 w-full rounded-lg animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* sticky action bar */}
      <div
        className="sticky bottom-0 -mx-6 px-6 py-3 border-t bg-white/95 backdrop-blur flex justify-end gap-3"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div className="h-9 w-24 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
      </div>
    </div>
  )
}
