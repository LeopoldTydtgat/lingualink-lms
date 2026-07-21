export default function Loading() {
  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      {/* header */}
      <div className="max-w-6xl mx-auto flex items-center gap-3 mb-6">
        <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
        <div className="h-7 w-52 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* single scrolling form — one card per section */}
      <div className="max-w-6xl mx-auto space-y-8 pb-28">
        {[2, 1, 4].map((fields, s) => (
          <div key={s} className="card-elevated p-5 space-y-4">
            {/* section heading — accent bar + title */}
            <div className="flex items-center gap-2.5">
              <span className="block rounded-full bg-gray-200 animate-pulse"
                style={{ width: '3px', height: '18px' }} />
              <div className="h-4 w-36 rounded bg-gray-200 animate-pulse" />
            </div>
            {Array.from({ length: fields }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
                <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* sticky action bar */}
      <div
        className="sticky bottom-0 -mx-6 px-6 py-3 border-t bg-white/95 backdrop-blur flex justify-end gap-3"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div className="h-9 w-24 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-44 rounded-lg bg-gray-200 animate-pulse" />
      </div>
    </div>
  )
}
