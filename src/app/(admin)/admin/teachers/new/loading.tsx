export default function Loading() {
  return (
    <div className="p-6 max-w-4xl">
      {/* header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="h-4 w-20 rounded bg-gray-200 animate-pulse" />
        <div className="h-7 w-40 rounded bg-gray-200 animate-pulse" />
      </div>

      {/* tab bar */}
      <div className="flex gap-0 mb-6 border border-gray-200 rounded-lg overflow-hidden w-fit">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-9 w-36 bg-gray-200 animate-pulse" />
        ))}
      </div>

      {/* card */}
      <div
        className="bg-white rounded-xl p-6 space-y-5"
        style={{ border: '1px solid #E0DFDC' }}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i}>
            <div className="h-3 w-24 rounded bg-gray-200 animate-pulse mb-2" />
            <div className="h-10 w-full rounded-lg bg-gray-200 animate-pulse" />
          </div>
        ))}

        {/* action row */}
        <div className="flex justify-end gap-3 pt-2">
          <div className="h-9 w-24 rounded-lg bg-gray-200 animate-pulse" />
          <div className="h-9 w-32 rounded-lg bg-gray-200 animate-pulse" />
        </div>
      </div>
    </div>
  )
}
