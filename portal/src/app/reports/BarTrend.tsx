/** Single-series bar trend (inline SVG). One hue, thin rounded bars on a baseline, native hover tooltips, last value labelled. */
export function BarTrend(p: { title: string; points: { label: string; short: string; value: number; display: string }[] }) {
  const W = 640, H = 180, L = 8, R = 8, T = 22, B = 26;
  const max = Math.max(1, ...p.points.map((x) => x.value));
  const n = p.points.length;
  const slot = (W - L - R) / n;
  const bw = Math.max(4, Math.min(28, slot - 6));
  const y = (v: number) => T + (H - T - B) * (1 - v / max);
  const last = p.points[n - 1];
  return (
    <figure className="trend">
      <figcaption>{p.title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${p.title}: ${p.points.map((x) => `${x.label} ${x.display}`).join(", ")}`}>
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} className="trend-axis" />
        {p.points.map((x, i) => {
          const cx = L + slot * i + slot / 2;
          const top = y(x.value);
          const h = Math.max(0, H - B - top);
          return (
            <g key={x.label} className="trend-bar">
              <title>{`${x.label}: ${x.display}`}</title>
              <rect x={L + slot * i} y={T} width={slot} height={H - T - B} fill="transparent" />
              {h > 0 && <path d={`M${cx - bw / 2},${H - B} V${top + Math.min(4, h)} q0,-4 4,-4 h${bw - 8} q4,0 4,4 V${H - B} Z`} className="trend-mark" />}
              {(n <= 12 || i % 2 === n % 2) && <text x={cx} y={H - 8} textAnchor="middle" className="trend-tick">{x.short}</text>}
            </g>
          );
        })}
        {last && <text x={L + slot * (n - 1) + slot / 2 + bw / 2} y={Math.max(12, y(last.value) - 6)} textAnchor="end" className="trend-value">{last.display}</text>}
      </svg>
    </figure>
  );
}
