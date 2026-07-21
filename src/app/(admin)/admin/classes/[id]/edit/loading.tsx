export default function Loading() {
  return (
    <div className="p-6">
      <div className="max-w-6xl mx-auto">
        {/* back link */}
        <div className="h-4 w-40 rounded bg-gray-200 animate-pulse mb-5" />

        {/* header */}
        <div className="space-y-2 mb-7">
          <div className="h-6 w-36 rounded bg-gray-200 animate-pulse" />
          <div className="h-3 w-64 rounded bg-gray-200 animate-pulse" />
        </div>

        {/* form card */}
        <div className="card-elevated p-6 space-y-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i}>
              <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
              <div className="h-10 w-full rounded-lg bg-gray-200 animate-pulse" />
            </div>
          ))}
        </div>

        {/* action row */}
        <div className="flex gap-3 mt-6">
          <div className="h-11 w-24 rounded-lg bg-gray-200 animate-pulse" />
          <div className="h-11 w-36 rounded-lg bg-gray-200 animate-pulse" />
        </div>
      </div>
    </div>
  )
}
