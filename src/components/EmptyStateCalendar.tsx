"use client";

export function EmptyStateCalendar() {
  return (
    <div
      role="img"
      aria-label="No upcoming classes"
      style={{ width: 88, height: 88 }}
    >
      <style>{`
        @keyframes llBreath { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes llRing { 0%,100% { transform: scale(1); opacity: .5; } 50% { transform: scale(1.06); opacity: .75; } }
        @keyframes llEcho { 0%,55% { opacity: 0; transform: scale(1); } 60% { opacity: .5; transform: scale(1); } 100% { opacity: 0; transform: scale(1.5); } }
        .ll-breath { transform-box: fill-box; transform-origin: center; animation: llBreath 4.2s ease-in-out infinite; }
        .ll-ring   { transform-box: fill-box; transform-origin: center; animation: llRing 4.2s ease-in-out infinite; }
        .ll-echo   { transform-box: fill-box; transform-origin: center; animation: llEcho 5s ease-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .ll-breath, .ll-ring, .ll-echo { animation: none; opacity: 1; transform: none; }
        }
      `}</style>
      <svg viewBox="0 0 100 100" width="88" height="88" xmlns="http://www.w3.org/2000/svg">
        <circle className="ll-echo" cx="50" cy="50" r="44" fill="none" stroke="#FF8303" strokeWidth="1.4" />
        <circle className="ll-ring" cx="50" cy="50" r="44" fill="none" stroke="#FF8303" strokeWidth="1.4" opacity="0.55" />
        <g className="ll-breath" fill="none" stroke="#FF8303" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="26" y="29" width="48" height="42" rx="6" />
          <line x1="26" y1="41" x2="74" y2="41" />
          <line x1="37" y1="21" x2="37" y2="34" />
          <line x1="63" y1="21" x2="63" y2="34" />
        </g>
        <g fill="#FF8303">
          <circle cx="41" cy="54" r="2.6" />
          <circle cx="50" cy="54" r="2.6" />
          <circle cx="59" cy="54" r="2.6" />
        </g>
      </svg>
    </div>
  );
}
