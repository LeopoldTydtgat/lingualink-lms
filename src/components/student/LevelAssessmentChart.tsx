'use client';

import { CEFR_MAX_VALUE, type RadarSkill } from '@/lib/levels/levelData';

// The student-facing level readout: a hand-rolled SVG radar that prints each
// skill's CEFR level directly on the chart, beneath its axis label. Two pages
// render it - the Progress page's Level Tracker card and a past class's "your
// level at this class" card - so they cannot drift on geometry, stroke or font.
//
// This is a deliberate port of the admin report-detail chart
// (src/app/(admin)/admin/reports/[id]/ReportDetailClient.tsx, RadarChart) -
// same 280px fixed size, same 90px max radius, same grid, colours and label
// geometry - so all three surfaces read identically. It replaced a recharts
// radar plus a per-skill scorecard listed underneath: the level is on the chart
// now, so the scorecard is gone rather than kept alongside.
//
// Fixed width/height with no responsive scaling is the admin behaviour and is
// intentional here; do not add viewBox scaling the admin version does not have.
//
// It renders no card shell, no header and no provenance or scale copy: those
// differ per page and stay page-side.

interface LevelAssessmentChartProps {
  radarData: RadarSkill[];
  unassessedSkills: string[];
}

// Skills the teacher left ungraded are DROPPED upstream by toRadarData (they
// used to be plotted at the centre, which read as a failing grade); the caller
// passes their names in unassessedSkills and they are listed underneath.
function RadarSvg({ points }: { points: RadarSkill[] }) {
  const size = 280; const cx = size / 2; const cy = size / 2;
  const maxRadius = 90;
  const n = points.length;

  // The consumers gate on hasUsableLevelData, so n >= 1 here; this only keeps
  // the angle maths below from dividing by zero if that ever stops being true.
  if (n === 0) return null;

  function angle(i: number) { return (Math.PI * 2 * i) / n - Math.PI / 2; }
  function axisPoint(i: number, fraction: number) {
    const r = maxRadius * fraction;
    return { x: cx + r * Math.cos(angle(i)), y: cy + r * Math.sin(angle(i)) };
  }

  const gridPolygons = [0.2, 0.4, 0.6, 0.8, 1].map((f) =>
    points.map((_, i) => { const p = axisPoint(i, f); return `${p.x},${p.y}`; }).join(' ')
  );
  // Fixed A1..C2 radial domain, matching the admin surface: a B1 sits at the
  // same radius everywhere, rather than the scale being derived from whatever
  // this one report happened to contain.
  const dataPoints  = points.map((s, i) => axisPoint(i, s.value / CEFR_MAX_VALUE));
  const dataPolygon = dataPoints.map((p) => `${p.x},${p.y}`).join(' ');
  const labelPoints = points.map((_, i) => {
    const r = maxRadius + 20;
    return { x: cx + r * Math.cos(angle(i)), y: cy + r * Math.sin(angle(i)) };
  });

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      {gridPolygons.map((pts, gi) => <polygon key={gi} points={pts} fill="none" stroke="#E5E7EB" strokeWidth="1" />)}
      {points.map((_, i) => { const end = axisPoint(i, 1); return <line key={i} x1={cx} y1={cy} x2={end.x} y2={end.y} stroke="#E5E7EB" strokeWidth="1" />; })}
      <polygon points={dataPolygon} fill="#FF8303" fillOpacity={0.25} stroke="#FF8303" strokeWidth="2" />
      {dataPoints.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={4} fill="#FF8303" />)}
      {points.map((s, i) => {
        const lp = labelPoints[i];
        return (
          <g key={s.key}>
            <text x={lp.x} y={lp.y} textAnchor="middle" dominantBaseline="middle" fontSize="10" fontFamily="Inter, sans-serif" fill="#374151" fontWeight="500">{s.skill}</text>
            <text x={lp.x} y={lp.y + 12} textAnchor="middle" dominantBaseline="middle" fontSize="9" fontFamily="Inter, sans-serif" fill="#FF8303" fontWeight="600">{s.level}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function LevelAssessmentChart({
  radarData,
  unassessedSkills,
}: LevelAssessmentChartProps) {
  return (
    <div className="flex flex-col items-center">
      <RadarSvg points={radarData} />

      {/* Skills this assessment left blank. Named rather than drawn, so a
          partial assessment reads as partial instead of as a differently
          shaped chart. */}
      {unassessedSkills.length > 0 && (
        <p className="text-xs text-center mt-3" style={{ color: '#9ca3af' }}>
          Not yet assessed: {unassessedSkills.join(', ')}
        </p>
      )}
    </div>
  );
}
