export default function Loading() {
  return (
    <div className="p-6">
      {/* Page header — matches the live full-width header bar */}
      <div
        style={{
          borderBottom: '1px solid #E0DFDC',
          paddingBottom: '16px',
          marginBottom: '24px',
          width: '100%',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
        }}
      >
        <div className="space-y-2">
          <div className="h-7 w-32 rounded bg-gray-200 animate-pulse" />
          <div className="h-4 w-56 rounded bg-gray-200 animate-pulse" />
        </div>
        <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse shrink-0" />
      </div>

      {/* Search and filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <div className="h-10 flex-1 min-w-48 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-10 w-36 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-10 w-32 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-10 w-28 rounded-lg bg-gray-200 animate-pulse" />
        <div className="h-10 w-32 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* Table */}
      <div className="card-elevated overflow-hidden">
        {/* Header row */}
        <div className="flex items-center gap-4 px-4 py-3 border-b border-gray-100 bg-gray-50">
          <div className="h-3 rounded bg-gray-200 animate-pulse flex-1" />
          <div className="h-3 rounded bg-gray-200 animate-pulse flex-1" />
          <div className="h-3 rounded bg-gray-200 animate-pulse flex-1" />
          <div className="h-3 rounded bg-gray-200 animate-pulse flex-1" />
          <div className="h-3 w-24 rounded bg-gray-200 animate-pulse shrink-0" />
          <div className="h-3 w-20 rounded bg-gray-200 animate-pulse shrink-0" />
        </div>

        {/* Body rows */}
        {Array.from({ length: 6 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-4 py-3 border-b border-gray-50"
          >
            {/* Student — avatar + name */}
            <div className="flex items-center gap-3 flex-1 min-w-0">
              <div className="w-8 h-8 rounded-full bg-gray-200 animate-pulse flex-shrink-0" />
              <div className="h-4 w-28 rounded bg-gray-200 animate-pulse" />
            </div>
            {/* Email */}
            <div className="h-4 rounded bg-gray-200 animate-pulse flex-1" />
            {/* Company pill */}
            <div className="flex-1">
              <div className="h-5 w-24 rounded-full bg-gray-200 animate-pulse" />
            </div>
            {/* Teacher pills */}
            <div className="flex-1 flex gap-1">
              <div className="h-5 w-20 rounded-full bg-gray-200 animate-pulse" />
            </div>
            {/* Hours pill */}
            <div className="h-5 w-24 rounded-full bg-gray-200 animate-pulse shrink-0" />
            {/* Status pill */}
            <div className="h-5 w-20 rounded-full bg-gray-200 animate-pulse shrink-0" />
          </div>
        ))}
      </div>
    </div>
  )
}
