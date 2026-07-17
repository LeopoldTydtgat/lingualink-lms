export default function Loading() {
  return (
    <div className="space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      <div>
        <div className="h-7 w-44 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-56 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      {/* Profile header */}
      <div
        className="bg-white rounded-xl p-6 flex items-center gap-4"
        style={{ border: '1px solid #E0DFDC' }}
      >
        <div className="h-16 w-16 rounded-full bg-gray-200 animate-pulse shrink-0" />
        <div className="space-y-2">
          <div className="h-5 w-48 rounded bg-gray-200 animate-pulse" />
          <div className="h-3 w-40 rounded bg-gray-200 animate-pulse" />
        </div>
      </div>

      {/* Form field rows */}
      <div
        className="bg-white rounded-xl p-6 space-y-5"
        style={{ border: '1px solid #E0DFDC' }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
            <div className="h-10 w-full rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
