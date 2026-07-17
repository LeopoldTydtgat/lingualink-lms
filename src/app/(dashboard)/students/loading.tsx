export default function Loading() {
  return (
    <div className="space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      <div className="flex items-center justify-between">
        <div>
          <div className="h-7 w-52 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-40 rounded bg-gray-200 animate-pulse mt-2" />
        </div>
        <div className="h-9 w-36 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      <div className="flex flex-col gap-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-xl p-4 flex items-center gap-4"
            style={{ border: '1px solid #E0DFDC' }}
          >
            <div className="h-12 w-12 rounded-full bg-gray-200 animate-pulse shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-44 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-28 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-8 w-24 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
