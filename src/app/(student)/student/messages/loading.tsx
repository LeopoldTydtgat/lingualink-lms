export default function Loading() {
  return (
    <div
      className="flex bg-white rounded-lg overflow-hidden"
      style={{ border: '1px solid #E0DFDC', height: 'calc(100vh - 120px)' }}
    >
      {/* Contacts list column */}
      <div className="w-72 shrink-0 flex flex-col" style={{ borderRight: '1px solid #E0DFDC' }}>
        {/* Header + search */}
        <div className="p-4 space-y-3" style={{ borderBottom: '1px solid #E0DFDC' }}>
          <div className="flex items-center justify-between">
            <div className="h-5 w-24 rounded bg-gray-200 animate-pulse" />
            <div className="h-7 w-7 rounded-full bg-gray-200 animate-pulse" />
          </div>
          <div className="h-8 w-full rounded-lg bg-gray-200 animate-pulse" />
        </div>

        {/* Contact rows */}
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
  )
}
