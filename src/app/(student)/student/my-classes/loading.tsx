export default function Loading() {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto' }}>
      {/* Page header + Book a Class button */}
      <div
        className="flex items-start justify-between"
        style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px' }}
      >
        <div>
          <div className="h-6 w-40 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-32 rounded bg-gray-200 animate-pulse mt-2" />
        </div>
        <div className="h-10 w-36 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Next class hero card */}
      <div
        className="bg-white rounded-xl p-6"
        style={{ border: '1px solid #E0DFDC', marginBottom: '24px' }}
      >
        <div className="h-3 w-24 rounded bg-gray-200 animate-pulse" />
        <div className="flex items-center gap-4 mt-4">
          <div className="h-14 w-14 rounded-full bg-gray-200 animate-pulse shrink-0" />
          <div className="flex-1 space-y-2">
            <div className="h-5 w-52 rounded bg-gray-200 animate-pulse" />
            <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
          </div>
          <div className="h-10 w-28 rounded-lg bg-gray-200 animate-pulse" />
        </div>
      </div>

      {/* Upcoming class list rows */}
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
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
            <div className="h-8 w-20 rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
