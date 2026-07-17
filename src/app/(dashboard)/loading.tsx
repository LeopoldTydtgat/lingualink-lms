export default function Loading() {
  return (
    <div className="space-y-6" style={{ backgroundColor: '#f9fafb' }}>
      <div>
        <div className="h-7 w-48 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-64 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            key={i}
            className="bg-white rounded-xl p-6"
            style={{ border: '1px solid #E0DFDC' }}
          >
            <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
            <div className="h-3 w-full rounded bg-gray-200 animate-pulse mt-3" />
            <div className="h-3 w-2/3 rounded bg-gray-200 animate-pulse mt-2" />
          </div>
        ))}
      </div>
    </div>
  )
}
