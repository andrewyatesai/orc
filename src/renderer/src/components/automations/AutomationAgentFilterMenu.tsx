import React from 'react'
import { ListFilter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentIcon, getAgentCatalog } from '@/lib/agent-catalog'
import { searchAgentPickerEntries } from '@/lib/agent-picker-search'
import { translate } from '@/i18n/i18n'
import {
  EMPTY_AUTOMATION_AGENT_FILTER,
  toggleAutomationAgentFilter,
  type AutomationAgentFilter
} from './automation-agent-filter'

export function AutomationAgentFilterMenu({
  filter,
  onChange
}: {
  filter: AutomationAgentFilter
  onChange: (next: AutomationAgentFilter) => void
}): React.JSX.Element {
  const agentLabel = translate('auto.components.automations.AutomationAgentFilterMenu.agent', 'Agent')
  const agents = getAgentCatalog()
  const [agentQuery, setAgentQuery] = React.useState('')
  const filteredAgents = searchAgentPickerEntries(agents, agentQuery)
  const activeCount = filter.length

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 shrink-0 gap-1.5 border border-border bg-background px-2.5 text-xs shadow-none hover:bg-muted/50 focus-visible:border-ring/70 focus-visible:ring-0"
        >
          <ListFilter className="size-3.5" />
          {agentLabel}
          {activeCount > 0 ? (
            <span className="rounded-full bg-foreground px-1.5 text-[10px] font-semibold leading-4 text-background">
              {activeCount}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="scrollbar-sleek max-h-80 w-56 overflow-y-auto"
      >
        <div className="p-1">
          <Input
            value={agentQuery}
            onChange={(event) => setAgentQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' && event.key !== 'Tab') {
                event.stopPropagation()
              }
            }}
            onPointerDown={(event) => event.stopPropagation()}
            placeholder={translate(
              'auto.components.automations.AutomationAgentFilterMenu.926e785e4d',
              'Search agents...'
            )}
            aria-label={translate(
              'auto.components.automations.AutomationAgentFilterMenu.926e785e4d',
              'Search agents...'
            )}
            className="h-7 px-2 text-xs"
          />
        </div>
        <DropdownMenuCheckboxItem
          checked={activeCount === 0}
          onCheckedChange={() => onChange(EMPTY_AUTOMATION_AGENT_FILTER)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate('auto.components.automations.AutomationAgentFilterMenu.all', 'All')}
        </DropdownMenuCheckboxItem>
        {filteredAgents.map((agent) => (
          <DropdownMenuCheckboxItem
            key={agent.id}
            checked={filter.includes(agent.id)}
            onCheckedChange={() => onChange(toggleAutomationAgentFilter(filter, agent.id))}
            onSelect={(event) => event.preventDefault()}
          >
            <span className="inline-flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_svg]:size-3.5!">
              <AgentIcon agent={agent.id} size={14} />
            </span>
            {agent.label}
          </DropdownMenuCheckboxItem>
        ))}
        {filteredAgents.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            {translate(
              'auto.components.automations.AutomationAgentFilterMenu.491043ee45',
              'No agents match your search.'
            )}
          </div>
        ) : null}
        {activeCount > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onChange(EMPTY_AUTOMATION_AGENT_FILTER)}>
              {translate('auto.components.automations.AutomationAgentFilterMenu.clear', 'Clear filters')}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
