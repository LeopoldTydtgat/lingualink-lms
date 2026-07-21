export default function Loading() {
  return (
    <div className="p-6 min-h-full" style={{ backgroundColor: '#f9fafb' }}>
      {/* header — "← Companies / Add Company" */}
      <div className="max-w-6xl mx-auto flex items-center gap-3 mb-6">
        <div className="h-4 w-24 rounded bg-gray-200 animate-pulse" />
        <span className="text-gray-300">/</span>
        <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* single scrolling form — one card per section */}
      <div className="max-w-6xl mx-auto space-y-6 pb-28">

        {/* 1. Company Details — name + (type / status) */}
        <div className="card-elevated p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="block rounded-full bg-gray-200 animate-pulse"
              style={{ width: '3px', height: '18px' }} />
            <div className="h-4 w-36 rounded bg-gray-200 animate-pulse" />
          </div>
          <div>
            <div className="h-3 w-28 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i}>
                <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
                <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>
        </div>

        {/* 2. Contact Details — contact name + (email / phone) + (country / billing email) */}
        <div className="card-elevated p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="block rounded-full bg-gray-200 animate-pulse"
              style={{ width: '3px', height: '18px' }} />
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
          </div>
          <div>
            <div className="h-3 w-36 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
          </div>
          {Array.from({ length: 2 }).map((_, row) => (
            <div key={row} className="grid grid-cols-2 gap-4">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i}>
                  <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
                  <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* 3. Settings — cancellation policy toggle (two help lines) + tags */}
        <div className="card-elevated p-5 space-y-4">
          <div className="flex items-center gap-2.5">
            <span className="block rounded-full bg-gray-200 animate-pulse"
              style={{ width: '3px', height: '18px' }} />
            <div className="h-4 w-24 rounded bg-gray-200 animate-pulse" />
          </div>
          <div>
            <div className="h-3 w-44 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="flex gap-0 border border-gray-200 rounded-lg overflow-hidden w-fit">
              {Array.from({ length: 2 }).map((_, i) => (
                <div key={i} className="h-9 w-40 bg-gray-200 animate-pulse" />
              ))}
            </div>
            <div className="h-3 w-full max-w-md rounded bg-gray-200 animate-pulse mt-2" />
            <div className="h-3 w-56 rounded bg-gray-200 animate-pulse mt-1" />
          </div>
          <div>
            <div className="h-3 w-16 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="h-9 w-full rounded-lg bg-gray-200 animate-pulse" />
          </div>
        </div>

        {/* 4. Company notes — amber */}
        <div
          className="rounded-xl border p-5 space-y-4"
          style={{ backgroundColor: '#fffbeb', borderColor: '#fde68a' }}
        >
          <div className="h-4 w-80 rounded animate-pulse" style={{ backgroundColor: '#fde68a' }} />
          <div className="h-3 w-32 rounded animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
          <div className="h-24 w-full rounded-lg animate-pulse" style={{ backgroundColor: '#fef3c7' }} />
        </div>
      </div>

      {/* sticky action bar */}
      <div
        className="sticky bottom-0 -mx-6 px-6 py-3 border-t bg-white/95 backdrop-blur flex justify-end gap-3"
        style={{ borderColor: '#E0DFDC' }}
      >
        <div className="h-9 w-24 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-36 rounded-lg bg-gray-200 animate-pulse" />
      </div>
    </div>
  )
}
