import React from "react";

export function DocCompletenessRing({ uploaded = 0, total = 23, size = 34 }) {
  const stroke = 4;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const pct = total > 0 ? Math.min(1, uploaded / total) : 0;
  const offset = circ * (1 - pct);
  let color = "#EF4444";
  if (pct >= 0.66) color = "#10B981";
  else if (pct >= 0.34) color = "#F59E0B";
  return (
    <div
      className="inline-flex items-center justify-center relative"
      style={{ width: size, height: size }}
      title={`${uploaded} of ${total} documents uploaded (${Math.round(pct * 100)}%)`}
      data-testid="doc-completeness-ring"
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} stroke="#E5E7EB" strokeWidth={stroke} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={offset} fill="none"
          style={{ transition: "stroke-dashoffset 0.4s ease" }}
        />
      </svg>
      <span className="absolute text-[9px] font-bold leading-none" style={{ color }}>{uploaded}/{total}</span>
    </div>
  );
}
