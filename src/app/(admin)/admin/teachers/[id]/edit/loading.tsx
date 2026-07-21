export default function Loading() {
  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      {/* header */}
      <div className="max-w-6xl mx-auto flex items-center gap-3 mb-6">
        <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
        <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* tab bar + the single visible section card */}
      <div className="max-w-6xl mx-auto space-y-6 pb-28">
        <div className="flex gap-0 border border-gray-200 rounded-lg overflow-hidden w-fit">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="h-9 w-36 bg-gray-200 animate-pulse" />
          ))}
        </div>

        <div className="card-elevated p-5 space-y-4">
          {/* section heading — accent bar + title */}
          <div className="flex items-center gap-2.5">
            <span className="block rounded-full bg-gray-200 animate-pulse"
              style={{ width: '3px', height: '18px' }} />
            <div className="h-4 w-36 rounded bg-gray-200 animate-pulse" />
          </div>

          {/* two-up name row */}
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
                <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>

          {/* stacked fields */}
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
              <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
            </div>
          ))}

          {/* three-up date row */}
          <div className="grid grid-cols-3 gap-4">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
                <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>

          {/* section nav button */}
          <div className="flex justify-end pt-2">
            <div className="h-9 w-56 rounded-lg bg-gray-200 animate-pulse" />
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
