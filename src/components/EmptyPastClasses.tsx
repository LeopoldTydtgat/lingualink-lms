"use client";

export function EmptyPastClasses() {
  return (
    <div role="img" aria-label="No past classes yet" style={{ width: 80, height: 80, margin: "0 auto 12px" }}>
      <style>{`
        @keyframes epcBreath { 0%,100% { transform: scale(1); } 50% { transform: scale(1.05); } }
        @keyframes epcRing { 0%,100% { transform: scale(1); opacity: .5; } 50% { transform: scale(1.06); opacity: .75; } }
        @keyframes epcCheck { 0%,15% { stroke-dashoffset: 40; } 35%,90% { stroke-dashoffset: 0; } 100% { stroke-dashoffset: 40; } }
        .epc-breath { transform-box: fill-box; transform-origin: center; animation: epcBreath 4s ease-in-out infinite; }
        .epc-ring { transform-box: fill-box; transform-origin: center; animation: epcRing 4s ease-in-out infinite; }
        .epc-check { stroke-dasharray: 40; stroke-dashoffset: 40; animation: epcCheck 4s ease-in-out infinite; }
        @media (prefers-reduced-motion: reduce) {
          .epc-breath, .epc-ring { animation: none; transform: none; opacity: 1; }
          .epc-check { animation: none; stroke-dashoffset: 0; }
        }
      `}</style>
      <svg viewBox="0 0 100 100" width="80" height="80" xmlns="http://www.w3.org/2000/svg">
        <circle className="epc-ring" cx="50" cy="50" r="40" fill="none" stroke="#FF8303" strokeWidth="1.4" opacity="0.55" />
        <g className="epc-breath" fill="none" stroke="#FF8303" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="50" cy="50" r="26" />
          <path className="epc-check" d="M38,51 L47,60 L63,41" />
        </g>
      </svg>
    </div>
  );
}
