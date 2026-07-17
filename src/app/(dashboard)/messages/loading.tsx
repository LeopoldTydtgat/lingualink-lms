export default function Loading() {
  return (
    <div className="space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      <div>
        <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-56 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      <div
        className="bg-white rounded-xl overflow-hidden flex"
        style={{ border: '1px solid #E0DFDC', height: '520px' }}
      >
        {/* Contacts list column */}
        <div className="w-72 shrink-0" style={{ borderRight: '1px solid #E0DFDC' }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 p-4">
              <div className="h-10 w-10 rounded-full bg-gray-200 animate-pulse shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
                <div className="h-3 w-40 rounded bg-gray-200 animate-pulse" />
              </div>
            </div>
          ))}
        </div>

        {/* Empty thread panel */}
        <div className="flex-1 flex items-center justify-center">
          <div className="h-4 w-48 rounded bg-gray-200 animate-pulse" />
        </div>
      </div>
    </div>
  )
}
