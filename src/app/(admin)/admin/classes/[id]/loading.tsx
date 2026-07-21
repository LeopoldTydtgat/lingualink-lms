export default function Loading() {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        {/* back link */}
        <div className="h-4 w-32 rounded bg-gray-200 animate-pulse mb-5" />

        {/* header */}
        <div className="flex items-start justify-between gap-4 mb-7">
          <div className="space-y-2">
            <div className="h-6 w-40 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-56 rounded bg-gray-200 animate-pulse" />
          </div>
          <div className="flex gap-2 shrink-0">
            <div className="h-8 w-24 rounded-lg bg-gray-200 animate-pulse" />
            <div className="h-8 w-20 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        </div>

        {/* Class Information */}
        <div className="card-elevated p-6 mb-5 space-y-4">
          <div className="h-3 w-36 rounded bg-gray-200 animate-pulse" />
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex justify-between gap-4">
              <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-40 rounded bg-gray-200 animate-pulse" />
            </div>
          ))}
        </div>

        {/* Teacher & Student */}
        <div className="card-elevated p-6 mb-5 space-y-4">
          <div className="h-3 w-36 rounded bg-gray-200 animate-pulse" />
          <div className="flex gap-4 flex-wrap">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="card-elevated p-3.5 flex items-center gap-3 flex-1 min-w-[200px]">
                <div className="h-10 w-10 rounded-full bg-gray-200 animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
                  <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Class Report */}
        <div className="card-elevated p-6 space-y-4">
          <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
          <div className="flex items-center justify-between gap-4">
            <div className="h-3 w-40 rounded bg-gray-200 animate-pulse" />
            <div className="h-8 w-28 rounded-lg bg-gray-200 animate-pulse shrink-0" />
          </div>
        </div>
      </div>
    </div>
  )
}
