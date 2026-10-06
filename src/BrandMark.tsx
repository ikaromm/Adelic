// Adelic mark (see desktop/assets/icon.svg): a 2-adic branching tree shaped as an "A"
// (the p-adic places) crossed by one continuous line (the real place), the two halves
// the adele ring joins. Strokes are thicker than the app icon so it reads at 24 px.
export function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="64 64 384 384" aria-hidden="true" focusable="false">
      <g fill="none" stroke="var(--accent)" strokeLinecap="round">
        <path d="M256 104 170 284M256 104l86 180" strokeWidth="58" />
        <path d="M170 284 116 404M170 284l42 120M342 284l-42 120M342 284l54 120" strokeWidth="38" />
      </g>
      <path d="M100 284h312" stroke="var(--info)" strokeWidth="32" strokeLinecap="round" />
      <g fill="var(--pink)">
        <circle cx="116" cy="404" r="28" />
        <circle cx="212" cy="404" r="28" />
        <circle cx="300" cy="404" r="28" />
        <circle cx="396" cy="404" r="28" />
      </g>
      <circle cx="256" cy="104" r="40" fill="var(--text)" />
    </svg>
  );
}
