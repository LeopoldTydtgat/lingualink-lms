'use client';

import {
  Radar,
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  PolarRadiusAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { CEFR_MAX_VALUE, type RadarSkill } from '@/lib/levels/levelData';

// The student-facing level readout: radar chart, per-skill scorecard, and the
// names of the skills this assessment left blank. Two pages render it - the
// Progress page's Level Tracker card and a past class's "your level at this
// class" card - and they had drifted on stroke width, tooltip presence and the
// angle-axis font. It renders no card shell, no header and no provenance or
// scale copy: those differ per page and stay page-side.
//
// The admin report detail deliberately does NOT use this - it keeps its own
// hand-rolled SVG and never pulls in recharts.

interface LevelAssessmentChartProps {
  radarData: RadarSkill[];
  unassessedSkills: string[];
}

export default function LevelAssessmentChart({
  radarData,
  unassessedSkills,
}: LevelAssessmentChartProps) {
  return (
    <>
      {/* The 460px cap, the wide left/right margins and the 72% outerRadius are
          one piece of containment: together they leave enough room for the
          longest angle-axis label, "Comprehension", to render whole. Widening
          the cap or shrinking the margins clips it mid-word. */}
      <div style={{ maxWidth: '460px', margin: '0 auto' }}>
        <div className="w-full" style={{ height: 320 }}>
          <ResponsiveContainer width="100%" height="100%">
            <RadarChart data={radarData} margin={{ top: 20, right: 60, bottom: 20, left: 60 }} outerRadius="72%">
              <PolarGrid stroke="#e5e7eb" />
              <PolarAngleAxis
                dataKey="skill"
                tick={{ fontSize: 12, fill: '#6b7280', fontFamily: 'Inter, sans-serif' }}
              />
              {/* Fixed A1..C2 domain so a B1 sits at the same radius on every
                  surface. Without it recharts derives the radius from this one
                  report, so an all-B1 assessment filled the grid exactly like
                  an all-C2 one. Ticks and axis line stay hidden - the pages
                  spell the scale out in copy instead. */}
              <PolarRadiusAxis
                domain={[0, CEFR_MAX_VALUE]}
                tick={false}
                axisLine={false}
              />
              <Radar
                name="Level"
                dataKey="value"
                stroke="#FF8303"
                fill="#FF8303"
                fillOpacity={0.25}
                strokeWidth={2}
              />
              {/* value typed as unknown - recharts passes ValueType which includes undefined */}
              <Tooltip
                formatter={(value: unknown, _name: unknown, item: { payload?: { level?: string } }) => [
                  item.payload?.level ?? String((value as number) ?? 0),
                  'Level',
                ]}
                contentStyle={{
                  fontSize: 12,
                  fontFamily: 'Inter, sans-serif',
                  borderRadius: 8,
                  border: '1px solid #e5e7eb',
                }}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Scorecard: the same assessed skills the chart plots, spelled out, so
          the exact CEFR level is readable without hovering a vertex. */}
      <div style={{ maxWidth: '460px', margin: '16px auto 0' }}>
        {radarData.map((d, i) => (
          <div
            key={d.key}
            className="flex items-center justify-between py-2"
            style={i === 0 ? undefined : { borderTop: '1px solid #f3f4f6' }}
          >
            <span className="text-sm" style={{ color: '#4b5563' }}>{d.skill}</span>
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-full"
              style={{ backgroundColor: '#FFF3E0', color: '#FF8303' }}
            >
              {d.level}
            </span>
          </div>
        ))}
      </div>

      {/* Skills this assessment left blank. Named rather than drawn, so a
          partial assessment reads as partial instead of as a differently
          shaped chart. */}
      {unassessedSkills.length > 0 && (
        <p className="text-xs text-center mt-3" style={{ color: '#9ca3af' }}>
          Not yet assessed: {unassessedSkills.join(', ')}
        </p>
      )}
    </>
  );
}
