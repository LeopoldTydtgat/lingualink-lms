export default function Loading() {
  return (
    <div className="p-6 space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      {/* header row */}
      <div
        className="flex items-center justify-between pb-4"
        style={{ borderBottom: '1px solid #E0DFDC' }}
      >
        <div className="space-y-2">
          <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-56 rounded bg-gray-200 animate-pulse" />
        </div>
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* stat card row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card-elevated p-4">
            <div className="h-3 w-2/3 rounded bg-gray-200 animate-pulse mb-3" />
            <div className="h-7 w-10 rounded bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>

      {/* two-panel row */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* left: today's classes */}
        <div className="lg:col-span-3 card-elevated">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
          </div>
          <div className="divide-y divide-gray-50">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3">
                <div className="h-3 w-10 rounded bg-gray-200 animate-pulse shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-4 w-1/2 rounded bg-gray-200 animate-pulse" />
                  <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
                </div>
                <div className="h-5 w-16 rounded-full bg-gray-200 animate-pulse shrink-0" />
              </div>
            ))}
          </div>
        </div>

        {/* right: pending reports */}
        <div className="lg:col-span-2 card-elevated">
          <div className="px-5 py-4 border-b border-gray-100">
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
          </div>
          <div className="divide-y divide-gray-50">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="px-5 py-3 space-y-2">
                <div className="h-4 w-2/3 rounded bg-gray-200 animate-pulse" />
                <div className="h-3 w-1/2 rounded bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* alerts panel */}
      <div className="card-elevated px-5 py-4">
        <div className="h-4 w-20 rounded bg-gray-200 animate-pulse mb-4" />
        <div className="space-y-3">
          <div className="h-4 w-3/4 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-1/2 rounded bg-gray-200 animate-pulse" />
        </div>
      </div>
    </div>
  )
}
