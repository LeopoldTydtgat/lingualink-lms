export default function Loading() {
  return (
    <div style={{ maxWidth: '720px', margin: '0 auto' }}>
      {/* Page title */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px' }}>
        <div className="h-6 w-40 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-72 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      {/* Profile photo card */}
      <div
        className="bg-white rounded-xl p-6 mb-6"
        style={{ border: '1px solid #E0DFDC' }}
      >
        <div className="h-4 w-32 rounded bg-gray-200 animate-pulse mb-4" />
        <div className="flex items-center gap-5">
          <div className="h-20 w-20 rounded-full bg-gray-200 animate-pulse shrink-0" />
          <div className="space-y-2">
            <div className="h-4 w-48 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-40 rounded bg-gray-200 animate-pulse" />
          </div>
        </div>
      </div>

      {/* Profile fields card */}
      <div
        className="bg-white rounded-xl p-6 space-y-5"
        style={{ border: '1px solid #E0DFDC' }}
      >
        <div className="h-4 w-36 rounded bg-gray-200 animate-pulse" />
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
