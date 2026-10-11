import type { ReactNode } from "react";
import { Button } from "@multica/ui/components/ui/button";
import { Skeleton } from "@multica/ui/components/ui/skeleton";
import { useT } from "../../i18n";

// Shared building blocks for the Dashboard's sections.

export const LIST_CLASS = "max-h-[30rem] divide-y overflow-y-auto rounded-lg border bg-card";
export const LIST_ROW_CLASS =
  "flex min-h-12 items-center gap-3 px-4 py-3 text-label transition-colors hover:bg-accent/50";

export function SectionHeading({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-label font-semibold uppercase tracking-wide text-muted-foreground">
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
