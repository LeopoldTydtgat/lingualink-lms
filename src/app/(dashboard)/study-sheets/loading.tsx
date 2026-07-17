export default function Loading() {
  return (
    <div className="space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      <div>
        <div className="h-7 w-56 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-64 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      {/* Search bar */}
      <div className="h-10 w-full max-w-md rounded-lg bg-gray-200 animate-pulse" />

      {/* Table rows */}
      <div
        className="bg-white rounded-xl overflow-hidden"
        style={{ border: '1px solid #E0DFDC' }}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between p-4"
            style={i > 0 ? { borderTop: '1px solid #E0DFDC' } : undefined}
          >
            <div className="space-y-2">
              <div className="h-4 w-56 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-8 w-20 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
