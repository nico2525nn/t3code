import { memo, useCallback } from "react";

import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import type { SettingsNavItem, SettingsSectionPath } from "./SettingsSidebarNav.items";

interface SettingsSidebarNavItemProps {
  readonly isActive: boolean;
  readonly item: SettingsNavItem;
  readonly onSelect: (to: SettingsSectionPath) => void;
}

export const SettingsSidebarNavItem = memo(function SettingsSidebarNavItem({
  isActive,
  item,
  onSelect,
}: SettingsSidebarNavItemProps) {
  const Icon = item.icon;
  const selectSettingsSection = useCallback(() => {
    onSelect(item.to);
  }, [item.to, onSelect]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={isActive}
        className={
          isActive
            ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
            : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
        }
        onClick={selectSettingsSection}
      >
        <Icon
          className={
            isActive
              ? "size-4 shrink-0 text-foreground"
              : "size-4 shrink-0 text-muted-foreground/60"
          }
        />
        <span className="truncate">{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
