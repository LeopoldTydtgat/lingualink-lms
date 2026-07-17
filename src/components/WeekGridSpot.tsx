"use client";

export function WeekGridSpot() {
  return (
    <div
      role="img"
      aria-label="Weekly availability calendar"
      style={{ width: 120, height: 110 }}
    >
      <style>{`
        @keyframes wgsBreath { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        .wgs-breath { transform-box: fill-box; transform-origin: center; animation: wgsBreath 4.2s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .wgs-breath { animation: none; transform: none; }
        }
      `}</style>
      <svg viewBox="0 0 120 110" width="120" height="110" xmlns="http://www.w3.org/2000/svg">
        {/* Soft backdrop circle top-left */}
        <circle cx="34" cy="34" r="28" fill="#FFF3E0" />
        {/* Ground ellipse */}
        <ellipse cx="60" cy="98" rx="44" ry="7" fill="#FFF0E0" />

        {/* Calendar card */}
        <g fill="none" stroke="#F0E4D6" strokeWidth="1.5">
          <rect x="24" y="24" width="72" height="64" rx="9" fill="#ffffff" />
        </g>
        {/* Header band */}
        <path
          d="M24,33 a9,9 0 0 1 9,-9 h54 a9,9 0 0 1 9,9 v6 h-72 z"
          fill="#FFB942"
        />

        {/* 3x3 grid of rounded cells: six #FFE8CC, three #FF8303 */}
        <g>
          <rect x="33" y="48" width="10" height="8" rx="2.5" fill="#FFE8CC" />
          <rect x="55" y="48" width="10" height="8" rx="2.5" fill="#FF8303" />
          <rect x="77" y="48" width="10" height="8" rx="2.5" fill="#FFE8CC" />

          <rect x="33" y="62" width="10" height="8" rx="2.5" fill="#FF8303" />
          <rect x="55" y="62" width="10" height="8" rx="2.5" fill="#FFE8CC" />
          <rect x="77" y="62" width="10" height="8" rx="2.5" fill="#FFE8CC" />

          <rect x="33" y="76" width="10" height="8" rx="2.5" fill="#FFE8CC" />
          <rect x="55" y="76" width="10" height="8" rx="2.5" fill="#FFE8CC" />
          <rect x="77" y="76" width="10" height="8" rx="2.5" fill="#FF8303" />
        </g>

        {/* Clock bottom-right */}
        <g className="wgs-breath">
          <circle cx="94" cy="86" r="16" fill="#FF8303" />
          <circle cx="94" cy="86" r="12" fill="#ffffff" />
          {/* Hour hand */}
          <line x1="94" y1="86" x2="94" y2="79" stroke="#111827" strokeWidth="2" strokeLinecap="round" />
          {/* Minute hand */}
          <line x1="94" y1="86" x2="100" y2="86" stroke="#FF8303" strokeWidth="2" strokeLinecap="round" />
        </g>
      </svg>
    </div>
  );
}
