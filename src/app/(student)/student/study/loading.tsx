export default function Loading() {
  return (
    <div className="max-w-4xl mx-auto">
      {/* Page title */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px' }}>
        <div className="h-7 w-28 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-80 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      {/* Section tabs */}
      <div className="flex gap-6 mb-6 border-b border-gray-200 pb-3">
        <div className="h-4 w-44 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* Section heading */}
      <div className="h-3 w-28 rounded bg-gray-200 animate-pulse mb-3" />

      {/* Assignment cards */}
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-xl p-4 flex items-center gap-4"
            style={{ border: '1px solid #E0DFDC' }}
          >
            <div className="h-12 w-12 rounded-lg bg-gray-200 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-48 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-36 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-9 w-24 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
