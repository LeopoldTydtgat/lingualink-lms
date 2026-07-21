export default function Loading() {
  return (
    <div className="p-6">
      {/* Page header */}
      <div style={{ borderBottom: '1px solid #E0DFDC', paddingBottom: '16px', marginBottom: '24px', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="h-7 w-56 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* Tab switcher */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 w-36 bg-gray-100 animate-pulse" />
        ))}
      </div>

      {/* Invoice template management */}
      <div className="card-elevated p-4 flex items-center justify-between mb-5">
        <div className="space-y-2">
          <div className="h-4 w-32 rounded bg-gray-200 animate-pulse" />
          <div className="h-3 w-64 rounded bg-gray-200 animate-pulse" />
        </div>
        <div className="h-9 w-36 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Filters + CSV export */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="h-9 w-40 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-40 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-40 rounded-lg bg-gray-200 animate-pulse" />
        <div className="ml-auto h-9 w-28 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Invoices table */}
      <div className="card-elevated overflow-hidden">
        <div className="divide-y divide-gray-100">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="px-5 py-4 flex items-center justify-between gap-4">
              <div className="h-4 w-40 rounded bg-gray-200 animate-pulse" />
              <div className="flex items-center gap-4 flex-shrink-0">
                <div className="h-4 w-16 rounded bg-gray-200 animate-pulse" />
                <div className="h-5 w-16 rounded-full bg-gray-200 animate-pulse" />
                <div className="h-6 w-16 rounded-lg bg-gray-200 animate-pulse" />
                <div className="h-6 w-12 rounded-lg bg-gray-200 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
