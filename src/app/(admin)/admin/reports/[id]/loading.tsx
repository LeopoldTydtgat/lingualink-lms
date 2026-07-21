export default function Loading() {
  return (
    <div className="p-6">
      {/* back link */}
      <div className="h-4 w-28 rounded bg-gray-200 animate-pulse mb-5" />

      {/* header row */}
      <div className="flex items-center justify-between mt-3 mb-6">
        <div className="h-6 w-40 rounded bg-gray-200 animate-pulse" />
        <div className="flex items-center gap-3">
          <div className="h-6 w-20 rounded-full bg-gray-200 animate-pulse" />
          <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
        </div>
      </div>

      {/* Class Info + Participants */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <div className="card-elevated p-5 space-y-4">
          <div className="h-4 w-24 rounded bg-gray-200 animate-pulse" />
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex justify-between">
                <div className="h-3 w-24 rounded bg-gray-200 animate-pulse" />
                <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
        <div className="card-elevated p-5 space-y-4">
          <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gray-200 animate-pulse shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gray-200 animate-pulse shrink-0" />
            <div className="space-y-1.5">
              <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
            </div>
          </div>
        </div>
      </div>

      {/* stacked full-width cards */}
      <div className="card-elevated p-5 mt-5 space-y-3">
        <div className="h-4 w-56 rounded bg-gray-200 animate-pulse" />
        <div className="h-3 w-full rounded bg-gray-200 animate-pulse" />
        <div className="h-3 w-5/6 rounded bg-gray-200 animate-pulse" />
        <div className="h-3 w-2/3 rounded bg-gray-200 animate-pulse" />
      </div>

      <div className="card-elevated p-5 mt-5 space-y-3">
        <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
        <div className="h-3 w-full rounded bg-gray-200 animate-pulse" />
        <div className="h-3 w-3/4 rounded bg-gray-200 animate-pulse" />
      </div>
    </div>
  )
}
