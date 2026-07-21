export default function Loading() {
  return (
    <div className="p-6 space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      {/* header block */}
      <div className="space-y-3">
        <div className="h-7 w-64 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-96 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* content rows */}
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-xl p-4 flex items-center gap-4"
            style={{ border: '1px solid #E0DFDC' }}
          >
            <div className="h-10 w-10 rounded-full bg-gray-200 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-1/3 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-1/2 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-8 w-20 rounded-lg bg-gray-200 animate-pulse shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}
