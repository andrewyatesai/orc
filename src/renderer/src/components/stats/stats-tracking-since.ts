import { getIntlLocale } from '@/i18n/i18n'

// Why: format through getIntlLocale() so the date follows the selected UI language rather than
// the OS locale — passing undefined lets Intl pick the runtime region regardless of the setting.
export function formatTrackingSince(timestamp: number | null): string {
  if (!timestamp) {
    return ''
  }
  const date = new Date(timestamp)
  return `Tracking since ${date.toLocaleDateString(getIntlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })}`
}
