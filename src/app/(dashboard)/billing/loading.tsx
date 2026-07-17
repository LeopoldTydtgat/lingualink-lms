export default function Loading() {
  return (
    <div className="space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      <div>
        <div className="h-7 w-48 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-60 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      {/* Summary card */}
      <div
        className="bg-white rounded-xl p-6"
        style={{ border: '1px solid #E0DFDC' }}
      >
        <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
        <div className="h-9 w-40 rounded bg-gray-200 animate-pulse mt-3" />
        <div className="h-3 w-52 rounded bg-gray-200 animate-pulse mt-3" />
      </div>

      {/* Invoice rows */}
      <div
        className="bg-white rounded-xl overflow-hidden"
        style={{ border: '1px solid #E0DFDC' }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center justify-between p-4"
            style={i > 0 ? { borderTop: '1px solid #E0DFDC' } : undefined}
          >
            <div className="space-y-2">
              <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-24 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-8 w-24 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
