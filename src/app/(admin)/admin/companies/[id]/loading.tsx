export default function Loading() {
  return (
    <div className="p-6">
      {/* header row — back link / name / status pill, Edit button on the right */}
      <div className="flex items-start justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="h-4 w-24 rounded bg-gray-200 animate-pulse" />
          <span className="text-gray-300">/</span>
          <div className="h-6 w-48 rounded bg-gray-200 animate-pulse" />
          <div className="h-5 w-16 rounded-full bg-gray-200 animate-pulse" />
        </div>
        <div className="h-9 w-20 rounded-lg bg-gray-200 animate-pulse" />
      </div>

      {/* tab bar — General Info / Students / Notes */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 w-32 bg-gray-200 animate-pulse" />
        ))}
      </div>

      {/* General Info card — label/value rows */}
      <div className="card-elevated p-6 space-y-1">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-4 py-2.5 border-b border-gray-50 last:border-0">
            <div className="h-4 w-32 rounded bg-gray-200 animate-pulse flex-shrink-0" />
            <div className="h-4 w-56 rounded bg-gray-200 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
