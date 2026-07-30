import type React from 'react'
import { Check, Star } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export type ItemRenderArgs = {
  key: string
  itemValue: string
  isChecked: boolean
  isDefault: boolean
  onSelect: () => void
  onSetDefault?: () => void
  icon: React.ReactNode
  label: string
}

export function AgentIconLabel({
  icon,
  label
}: {
  icon: React.ReactNode
  label: string
}): React.JSX.Element {
  return (
    <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
      <span className="inline-flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_svg]:size-3.5!">
        {icon}
      </span>
      <span className="truncate leading-none">{label}</span>
    </span>
  )
}

export function renderItem({
  key,
  itemValue,
  isChecked,
  isDefault,
  onSelect,
  onSetDefault,
  icon,
  label
}: ItemRenderArgs): React.ReactNode {
  const row = (
    <CommandItem
      key={key}
      value={itemValue}
      onSelect={onSelect}
      className="items-center gap-2 px-3 py-1.5"
    >
      <Check
        className={cn('size-4 shrink-0 text-foreground', isChecked ? 'opacity-100' : 'opacity-0')}
      />
      <AgentIconLabel icon={icon} label={label} />
    </CommandItem>
  )
  if (!onSetDefault) {
    return row
  }
  return (
    // Why: z-[70] sits above PopoverContent's z-[60] so the right-click menu
    // renders in front of the still-open combobox popover instead of behind it.
    <ContextMenu key={key}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="z-[70]">
        <ContextMenuItem onSelect={onSetDefault} disabled={isDefault}>
          <Star className="size-3.5" />
          {isDefault
            ? translate('auto.components.agent.AgentCombobox.1b0d6965fa', 'Current default')
            : translate('auto.components.agent.AgentCombobox.9c6b59fe58', 'Set as default')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
