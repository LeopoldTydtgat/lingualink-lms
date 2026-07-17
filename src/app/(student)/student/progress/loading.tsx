export default function Loading() {
  return (
    <div className="max-w-5xl mx-auto space-y-8">
      {/* Page title */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px' }}>
        <div className="h-7 w-44 rounded bg-gray-200 animate-pulse" />
        <div className="h-4 w-72 rounded bg-gray-200 animate-pulse mt-2" />
      </div>

      {/* Training Overview */}
      <section>
        <div className="h-4 w-40 rounded bg-gray-200 animate-pulse mb-3" />
        <div className="space-y-4">
          {/* Stat cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="bg-white rounded-xl p-4 space-y-3"
                style={{ border: '1px solid #E0DFDC' }}
              >
                <div className="h-3 w-20 rounded bg-gray-200 animate-pulse" />
                <div className="h-6 w-16 rounded bg-gray-200 animate-pulse" />
              </div>
            ))}
          </div>

          {/* Hours-used progress bar card */}
          <div
            className="bg-white rounded-xl p-5 space-y-3"
            style={{ border: '1px solid #E0DFDC' }}
          >
            <div className="flex justify-between">
              <div className="h-3 w-20 rounded bg-gray-200 animate-pulse" />
              <div className="h-3 w-32 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-3 w-full rounded-full bg-gray-200 animate-pulse" />
          </div>
        </div>
      </section>

      {/* Level Tracker chart */}
      <section>
        <div className="h-4 w-32 rounded bg-gray-200 animate-pulse mb-4" />
        <div
          className="bg-white rounded-xl p-6 flex items-center justify-center"
          style={{ border: '1px solid #E0DFDC', height: '320px' }}
        >
          <div className="h-48 w-48 rounded-full bg-gray-200 animate-pulse" />
        </div>
      </section>
    </div>
  )
}
