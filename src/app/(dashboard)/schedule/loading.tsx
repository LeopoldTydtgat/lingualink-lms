export default function Loading() {
  return (
    <div className="p-6" style={{ backgroundColor: '#f9fafb' }}>
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px' }}>
        <div className="h-7 w-64 rounded bg-gray-200 animate-pulse mb-2" />
        <div className="h-4 w-80 rounded bg-gray-200 animate-pulse" />
      </div>

      <div className="flex gap-6 mb-6">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-6 w-28 rounded bg-gray-200 animate-pulse" />
        ))}
      </div>

      <div
        className="bg-white rounded-xl grid grid-cols-7 gap-px overflow-hidden"
        style={{ border: '1px solid #E0DFDC' }}
      >
        {Array.from({ length: 28 }).map((_, i) => (
          <div key={i} className="h-16 bg-gray-100">
            <div className="h-3 w-6 rounded bg-gray-200 animate-pulse m-2" />
          </div>
        ))}
      </div>
    </div>
  )
}
