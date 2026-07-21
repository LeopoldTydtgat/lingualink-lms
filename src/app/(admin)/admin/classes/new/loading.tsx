export default function Loading() {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        {/* back link */}
        <div className="h-4 w-32 rounded bg-gray-200 animate-pulse mb-5" />

        {/* title */}
        <div className="h-6 w-40 rounded bg-gray-200 animate-pulse mb-2" />

        {/* step progress bar */}
        <div className="h-1 w-full rounded bg-gray-200 animate-pulse mb-8" />

        {/* step content card */}
        <div className="card-elevated p-6 space-y-4">
          <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3.5">
              <div className="h-11 w-11 rounded-full bg-gray-200 animate-pulse shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-3 w-1/3 rounded bg-gray-200 animate-pulse" />
                <div className="h-3 w-1/4 rounded bg-gray-200 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
