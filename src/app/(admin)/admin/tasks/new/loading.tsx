export default function Loading() {
  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      {/* header */}
      <div className="max-w-6xl mx-auto flex items-center gap-3 mb-6">
        <div className="h-4 w-16 rounded bg-gray-200 animate-pulse" />
        <div className="h-7 w-36 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* single scrolling form — one card per section */}
      <div className="max-w-6xl mx-auto space-y-6 pb-28">

        {/* 1. Task Details */}
        <div className="card-elevated p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="block rounded-full bg-gray-200 animate-pulse"
              style={{ width: '3px', height: '18px' }} />
            <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
          </div>

          {/* Title */}
          <div>
            <div className="h-3 w-16 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
          </div>

          {/* Priority + Reason */}
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
                <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>

          {/* Assigned To + Due Date */}
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i}>
              <div className="h-3 w-20 rounded bg-gray-200 animate-pulse mb-2" />
              <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
            </div>
          ))}
        </div>

        {/* 2. Link & Notes */}
        <div className="card-elevated p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="block rounded-full bg-gray-200 animate-pulse"
              style={{ width: '3px', height: '18px' }} />
            <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
          </div>

          {/* Linked To — type select + entity select */}
          <div>
            <div className="h-3 w-32 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="grid gap-2" style={{ gridTemplateColumns: '140px 1fr' }}>
              <div className="h-9 rounded-lg bg-gray-200 animate-pulse" />
              <div className="h-9 rounded-lg bg-gray-200 animate-pulse" />
            </div>
          </div>

          {/* Notes — taller textarea */}
          <div>
            <div className="h-3 w-14 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="h-24 w-full rounded-lg bg-gray-200 animate-pulse" />
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
