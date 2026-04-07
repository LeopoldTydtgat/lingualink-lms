export default function AdminDashboardPage() {
    return (
      <div>
        <h1 className="text-2xl font-bold text-gray-800 mb-2">Dashboard</h1>
        <p className="text-gray-500 mb-8">Welcome to the Lingualink Admin Portal.</p>
  
        {/* Placeholder cards — replaced with live data in Step 3 */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
          {[
            'Classes Today',
            'Pending Reports',
            'Flagged Reports',
            'Low Hours Students',
            'Invoices to Review',
            'Active Announcements',
          ].map((label) => (
            <div
              key={label}
              className="bg-white rounded-xl border border-gray-200 p-5"
            >
              <p className="text-sm text-gray-500">{label}</p>
              <p className="text-3xl font-bold text-gray-800 mt-1">—</p>
            </div>
          ))}
        </div>
  
        <div className="mt-8 bg-white rounded-xl border border-gray-200 p-5">
          <p className="text-sm font-semibold text-gray-700 mb-1">
            Admin Portal — Step 1 Complete
          </p>
          <p className="text-sm text-gray-500">
            Shell, navigation, auth middleware, and route protection are in place.
            Live dashboard data will be wired up in Step 3.
          </p>
        </div>
      </div>
    )
  }