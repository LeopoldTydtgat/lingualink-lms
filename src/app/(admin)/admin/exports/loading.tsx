export default function Loading() {
  return (
    <div className="p-6 space-y-6">
      {/* Page header */}
      <div
        className="w-full pb-4 border-b space-y-2"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div className="h-7 w-48 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-[28rem] max-w-full rounded bg-gray-200 animate-pulse" />
      </div>

      {/* Export cards */}
      <div className="flex flex-col gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card-elevated p-6">
            {/* Title + description + download button */}
            <div className="flex flex-wrap items-start justify-between gap-4 mb-3.5">
              <div className="flex-1 min-w-[200px] space-y-2">
                <div className="h-5 w-56 rounded bg-gray-200 animate-pulse" />
                <div className="h-3.5 w-3/4 rounded bg-gray-200 animate-pulse" />
              </div>
              <div className="h-9 w-36 shrink-0 rounded-lg bg-gray-200 animate-pulse" />
            </div>

            {/* Columns line */}
            <div className="h-3 w-2/3 rounded bg-gray-200 animate-pulse mb-3.5" />

            {/* Filter row */}
            <div className="flex flex-wrap items-end gap-3">
              <div className="h-9 w-[140px] rounded-lg bg-gray-200 animate-pulse" />
              <div className="h-9 w-[140px] rounded-lg bg-gray-200 animate-pulse" />
              <div className="h-9 w-[200px] rounded-lg bg-gray-200 animate-pulse" />
              <div className="h-9 w-[180px] rounded-lg bg-gray-200 animate-pulse" />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
