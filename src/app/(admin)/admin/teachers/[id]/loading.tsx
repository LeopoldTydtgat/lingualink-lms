export default function Loading() {
  return (
    <div className="p-6">
      {/* back link */}
      <div className="h-4 w-20 rounded bg-gray-200 animate-pulse mb-4" />

      {/* profile header card */}
      <div className="card-elevated p-6 mb-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-[72px] h-[72px] rounded-full bg-gray-200 animate-pulse shrink-0" />
            <div className="space-y-2">
              <div className="h-5 w-40 rounded bg-gray-200 animate-pulse" />
              <div className="h-4 w-52 rounded bg-gray-200 animate-pulse" />
              <div className="flex gap-2">
                <div className="h-5 w-20 rounded-full bg-gray-200 animate-pulse" />
                <div className="h-5 w-16 rounded-full bg-gray-200 animate-pulse" />
              </div>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap justify-end flex-shrink-0">
            <div className="h-9 w-16 rounded-lg bg-gray-200 animate-pulse" />
            <div className="h-9 w-36 rounded-lg bg-gray-200 animate-pulse" />
            <div className="h-9 w-24 rounded-lg bg-gray-200 animate-pulse" />
            <div className="h-9 w-20 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        </div>
      </div>

      {/* tab bar */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-9 w-24 bg-gray-200 animate-pulse" />
        ))}
      </div>

      {/* overview grid */}
      <div className="grid grid-cols-3 gap-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card-elevated p-5 space-y-4">
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-full rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-5/6 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-2/3 rounded bg-gray-200 animate-pulse" />
          </div>
        ))}

        {/* admin-only amber blocks — full width */}
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="col-span-3 rounded-xl border p-5 space-y-2"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}
          >
            <div className="h-4 w-48 rounded animate-pulse" style={{ backgroundColor: '#fde68a' }} />
            <div className="h-3 w-full rounded animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
            <div className="h-3 w-3/4 rounded animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
          </div>
        ))}
      </div>
    </div>
  )
}
