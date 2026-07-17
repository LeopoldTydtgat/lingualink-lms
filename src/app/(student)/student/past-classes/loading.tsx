export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto">
      {/* Page header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px' }}>
        <div className="h-6 w-44 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-40 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      {/* Search bar */}
      <div className="h-11 w-full rounded-lg bg-gray-200 animate-pulse mb-6" />

      {/* Past class list rows */}
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-xl p-4 flex items-center gap-4"
            style={{ border: '1px solid #E0DFDC' }}
          >
            <div className="h-12 w-12 rounded-full bg-gray-200 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-52 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-8 w-24 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
