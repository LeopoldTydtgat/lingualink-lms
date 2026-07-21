export default function Loading() {
  return (
    <div className="p-6">
      {/* Page header */}
      <div
        className="w-full flex items-center justify-between pb-4 mb-6 border-b"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div className="space-y-2">
          <div className="h-7 w-32 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-56 rounded bg-gray-200 animate-pulse" />
        </div>
        <div className="h-9 w-28 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Summary pills */}
      <div className="flex flex-wrap gap-3 mb-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="card-elevated px-5 py-3 min-w-[120px] space-y-2">
            <div className="h-6 w-8 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>

      {/* Filter bar */}
      <div className="card-elevated px-5 py-4 mb-5 flex flex-wrap items-center gap-3">
        <div className="h-4 w-12 rounded bg-gray-200 animate-pulse" />
        <div className="h-8 w-32 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-8 w-32 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-8 w-40 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Task rows */}
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="card-elevated px-5 py-4"
            style={{ borderLeft: '4px solid #e5e7eb' }}
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              {/* Left: title + badges, then meta */}
              <div className="flex-1 min-w-[200px] space-y-2">
                <div className="flex flex-wrap items-center gap-2.5">
                  <div className="h-4 w-56 rounded bg-gray-200 animate-pulse" />
                  <div className="h-4 w-14 rounded-full bg-gray-200 animate-pulse" />
                </div>
                <div className="flex flex-wrap gap-4">
                  <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
                  <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
                  <div className="h-3 w-24 rounded bg-gray-200 animate-pulse" />
                </div>
              </div>

              {/* Right: actions */}
              <div className="flex items-center gap-2 shrink-0">
                <div className="h-7 w-24 rounded-lg bg-gray-200 animate-pulse" />
                <div className="h-7 w-14 rounded-lg bg-gray-200 animate-pulse" />
                <div className="h-7 w-16 rounded-lg bg-gray-200 animate-pulse" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
