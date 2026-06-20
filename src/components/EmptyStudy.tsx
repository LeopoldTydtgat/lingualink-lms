"use client";

export function EmptyStudy() {
  return (
    <div role="img" aria-label="No assignments yet" style={{ width: 80, height: 80, margin: "0 auto 12px" }}>
      <style>{`
        @keyframes esBreath { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes esRing { 0%,100% { transform: scale(1); opacity: .5; } 50% { transform: scale(1.06); opacity: .75; } }
        .es-breath { transform-box: fill-box; transform-origin: center; animation: esBreath 4s ease-in-out infinite; }
        .es-ring { transform-box: fill-box; transform-origin: center; animation: esRing 4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .es-breath, .es-ring { animation: none; transform: none; opacity: 1; }
        }
      `}</style>
      <svg viewBox="0 0 100 100" width="80" height="80" xmlns="http://www.w3.org/2000/svg">
        <circle className="es-ring" cx="50" cy="50" r="40" fill="none" stroke="#FF8303" strokeWidth="1.4" opacity="0.55" />
        <g className="es-breath" fill="none" stroke="#FF8303" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M50,34 C42,28 30,28 22,32 L22,66 C30,62 42,62 50,68 C58,62 70,62 78,66 L78,32 C70,28 58,28 50,34 Z" />
          <line x1="50" y1="34" x2="50" y2="68" />
        </g>
      </svg>
    </div>
  );
}
