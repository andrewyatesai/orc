import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'

/** Captured output of an npx update run, behind a disclosure. */
export function SkillUpdateRunLog({ output }: { output: string }): React.JSX.Element | null {
  if (!output.trim()) {
    return null
  }
  return (
    <Collapsible>
      <CollapsibleTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="group -ml-2 gap-1.5 text-muted-foreground"
        >
          <ChevronDown className="size-3.5 transition-transform group-data-[state=open]:rotate-180" />
          {translate('auto.components.skills.SkillFreshnessUpdateDialog.showLog', 'Show log')}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        {/* Displayed verbatim, never parsed — `skills update` has no --json. */}
        <pre className="scrollbar-sleek max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted px-3 py-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {output.trim()}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
