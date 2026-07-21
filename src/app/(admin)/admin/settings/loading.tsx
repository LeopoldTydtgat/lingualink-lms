export default function Loading() {
  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      <div className="max-w-6xl mx-auto space-y-8 pb-28">

        {/* header */}
        <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', width: '100%' }}>
          <div className="h-7 w-56 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-80 rounded bg-gray-200 animate-pulse mt-2" />
        </div>

        {/* one card per settings section */}
        {[1, 1, 2, 1, 1, 1].map((rows, s) => (
          <div key={s} className="card-elevated overflow-hidden">
            {/* section heading — accent bar + title */}
            <div className="flex items-start gap-2.5 px-6 py-4">
              <span className="block rounded-full shrink-0 mt-0.5 bg-gray-200 animate-pulse"
                style={{ width: '3px', height: '18px' }} />
              <div>
                <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
                <div className="h-3 w-64 rounded bg-gray-200 animate-pulse mt-2" />
              </div>
            </div>
            <div className="divide-y divide-gray-100">
              {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="px-6 py-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-8">
                  <div className="sm:w-72 shrink-0">
                    <div className="h-4 w-44 rounded bg-gray-200 animate-pulse" />
                    <div className="h-3 w-56 rounded bg-gray-200 animate-pulse mt-2" />
                  </div>
                  <div className="flex-1">
                    <div className="h-9 w-full max-w-xs rounded-lg bg-gray-200 animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* sticky action bar */}
      <div
        className="sticky bottom-0 -mx-6 px-6 py-3 border-t bg-white/95 backdrop-blur flex justify-end gap-3"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div className="h-9 w-36 rounded-lg bg-gray-200 animate-pulse" />
      </div>
    </div>
  )
}
