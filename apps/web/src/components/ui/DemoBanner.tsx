/**
 * Everything on screen today is placeholder data: there is no API yet. The PRD
 * requires demo data to be labelled and removed before release, so the label is a
 * component rather than a comment someone can forget.
 */
export function DemoBanner() {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-warning/30 bg-warning-bg px-4 py-2 text-xs text-warning sm:px-6">
      <span className="rounded-full bg-warning px-2 py-0.5 font-semibold text-inverse">[DEMO]</span>
      <span>
        Placeholder data for design review. No backend is connected, and nothing here is saved.
      </span>
    </div>
  );
}
