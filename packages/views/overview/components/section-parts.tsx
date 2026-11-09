import type { ReactNode } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../i18n";

// Shared building blocks for the Dashboard's sections.

// The list fills the rest of the page and is its only scroller. On a phone it
// spans the screen, so rows start on the page gutter, and it ends with room
// for the floating chat button to clear the last row.
export const LIST_CLASS =
  "min-h-0 flex-1 divide-y overflow-y-auto border-t bg-card max-md:-mx-4 max-md:pb-20 md:rounded-lg md:border";
// A list section is a column so its list can take the height left under the
// heading.
export const LIST_SECTION_CLASS = "flex min-h-0 min-w-0 flex-1 flex-col";

export function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      {/* On a phone the page title already says it; screen readers keep it. */}
      <h2 className="text-label font-semibold uppercase tracking-wide text-muted-foreground max-md:sr-only">
        {children}
      </h2>
      {action}
    </div>
  );
}

export function EmptyBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border p-4 text-label text-muted-foreground">{children}</div>
  );
}

// A failed section says so and offers a retry; rendering it as empty would
// read as "nothing happened" (e.g. an older server without /api/activity).
export function ErrorBox({ onRetry }: { onRetry: () => void }) {
  const { t } = useT("overview");
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border p-4 text-label text-muted-foreground">
      <span>{t(($) => $.load_failed)}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        {t(($) => $.retry)}
      </Button>
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className={LIST_CLASS} aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex min-h-12 items-center gap-3 px-4 py-3">
          <Skeleton className="size-4 shrink-0 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}
