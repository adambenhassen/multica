"use client";

import { Search } from "@multica/ui/icons";
import { SidebarMenuButton } from "@multica/ui/components/ui/sidebar";
import {
  useShortcut,
} from "@multica/core/shortcuts";
import { useSearchStore } from "./search-store";
import { useT } from "../i18n";
import { ShortcutKeycaps } from "../common/shortcut-keycaps";

export function SearchTrigger() {
  const { t } = useT("search");
  const shortcut = useShortcut("openSearch");
  return (
    <SidebarMenuButton
      className="text-muted-foreground"
      onClick={() => useSearchStore.getState().setOpen(true)}
    >
      <Search />
      <span>{t(($) => $.trigger.label)}</span>
      {shortcut ? (
        // A keyboard shortcut is no use to a touch screen.
        <ShortcutKeycaps shortcut={shortcut} decorative className="pointer-events-none ml-auto [@media(hover:none)]:hidden" />
      ) : null}
    </SidebarMenuButton>
  );
}
