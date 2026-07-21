export default function Loading() {
  return (
    <div className="p-6">
      {/* Page header */}
      <div
        style={{
          borderBottom: '1px solid #E0DFDC',
          paddingBottom: '16px',
          marginBottom: '24px',
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div className="space-y-2">
          <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
        </div>
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Search and filters */}
      <div className="flex gap-3 mb-6">
        <div className="h-9 flex-1 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-36 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Table */}
      <div className="card-elevated overflow-hidden">
        {/* header row */}
        <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 bg-gray-50">
          <div className="h-3 w-20 rounded bg-gray-200 animate-pulse flex-[2]" />
          <div className="h-3 w-24 rounded bg-gray-200 animate-pulse flex-[2]" />
          <div className="h-3 w-16 rounded bg-gray-200 animate-pulse flex-1" />
          <div className="h-3 w-16 rounded bg-gray-200 animate-pulse flex-1" />
          <div className="h-3 w-14 rounded bg-gray-200 animate-pulse flex-1" />
          <div className="h-3 w-14 rounded bg-gray-200 animate-pulse flex-1" />
        </div>

        {/* body rows */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-4 py-3 border-b border-gray-50">
            <div className="flex items-center gap-3 flex-[2]">
              <div className="h-8 w-8 rounded-full bg-gray-200 animate-pulse shrink-0" />
              <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
            </div>
            <div className="h-4 w-40 rounded bg-gray-200 animate-pulse flex-[2]" />
            <div className="h-5 w-20 rounded-full bg-gray-200 animate-pulse flex-1" />
            <div className="h-5 w-16 rounded-full bg-gray-200 animate-pulse flex-1" />
            <div className="h-4 w-12 rounded bg-gray-200 animate-pulse flex-1" />
            <div className="h-4 w-8 rounded bg-gray-200 animate-pulse flex-1" />
          </div>
        ))}
      </div>
    </div>
  )
}
