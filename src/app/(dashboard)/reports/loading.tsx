export default function Loading() {
  return (
    <div className="space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      <div>
        <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-64 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-xl p-4 flex items-center justify-between"
            style={{ border: '1px solid #E0DFDC' }}
          >
            <div className="space-y-2">
              <div className="h-4 w-36 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-52 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-8 w-24 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
