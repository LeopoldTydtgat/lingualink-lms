export default function Loading() {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        {/* Back link */}
        <div className="h-4 w-20 rounded bg-gray-200 animate-pulse mb-4" />

        {/* Profile header card */}
        <div className="card-elevated p-6 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-center gap-4">
              <div className="w-[72px] h-[72px] rounded-full bg-gray-200 animate-pulse shrink-0" />
              <div className="space-y-2">
                <div className="h-5 w-40 rounded bg-gray-200 animate-pulse" />
                <div className="h-4 w-52 rounded bg-gray-200 animate-pulse" />
                <div className="flex gap-2 pt-1">
                  <div className="h-5 w-20 rounded-full bg-gray-200 animate-pulse" />
                  <div className="h-5 w-16 rounded-full bg-gray-200 animate-pulse" />
                  <div className="h-5 w-24 rounded-full bg-gray-200 animate-pulse" />
                </div>
              </div>
            </div>
            <div className="flex gap-2 flex-shrink-0">
              <div className="h-9 w-20 rounded-lg bg-gray-200 animate-pulse" />
              <div className="h-9 w-20 rounded-lg bg-gray-200 animate-pulse" />
            </div>
          </div>
        </div>

        {/* Tab bar — 7 tabs, wraps like the live one */}
        <div
          className="flex gap-0 mb-6 rounded-lg overflow-hidden w-fit flex-wrap"
          style={{ border: '1px solid #E0DFDC' }}
        >
          {Array.from({ length: 7 }).map((_, i) => (
            <div key={i} className="h-9 w-28 bg-gray-200 animate-pulse" />
          ))}
        </div>

        {/* Overview grid */}
        <div className="grid grid-cols-2 gap-6">
          {/* 5 standard info cards */}
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="card-elevated p-5 space-y-4">
              <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-full rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-5/6 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-2/3 rounded bg-gray-200 animate-pulse" />
            </div>
          ))}

          {/* Admin notes — amber */}
          <div
            className="rounded-xl border p-5 space-y-2"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}
          >
            <div className="h-4 w-56 rounded animate-pulse" style={{ backgroundColor: '#fde68a' }} />
            <div className="h-3 w-full rounded animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
            <div className="h-3 w-1/2 rounded animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
          </div>

          {/* Password override — amber, full width */}
          <div
            className="col-span-2 rounded-xl border p-5 space-y-3"
            style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}
          >
            <div className="h-4 w-52 rounded animate-pulse" style={{ backgroundColor: '#fde68a' }} />
            <div className="h-3 w-2/3 rounded animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
            <div className="flex gap-3 items-end">
              <div className="flex-1 h-10 rounded-lg animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
              <div className="h-10 w-32 rounded-lg animate-pulse shrink-0" style={{ backgroundColor: '#fde68a' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
