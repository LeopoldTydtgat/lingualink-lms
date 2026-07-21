export default function Loading() {
  return (
    <div className="p-6">
      {/* header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px' }}>
        <div className="h-7 w-32 rounded bg-gray-200 animate-pulse mb-2" />
        <div className="h-4 w-96 rounded bg-gray-200 animate-pulse mb-3" />
        <div className="flex gap-3">
          <div className="h-6 w-24 rounded-full bg-gray-200 animate-pulse" />
          <div className="h-6 w-40 rounded-full bg-gray-200 animate-pulse" />
        </div>
      </div>

      {/* tab bar */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        <div className="h-9 w-28 bg-gray-200 animate-pulse" />
        <div className="h-9 w-40 bg-gray-200 animate-pulse" />
      </div>

      {/* filter row */}
      <div className="flex flex-wrap gap-3 mb-5">
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-36 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* table */}
      <div className="card-elevated overflow-hidden">
        <div className="border-b border-gray-100 flex gap-3 px-3 py-3">
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-3 w-20 rounded bg-gray-200 animate-pulse" />
          ))}
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="border-b border-gray-50 last:border-0 flex items-center gap-3 px-3 py-3">
            <div className="h-3 w-24 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
            <div className="h-5 w-20 rounded-full bg-gray-200 animate-pulse" />
            <div className="h-3 w-24 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-16 rounded bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
