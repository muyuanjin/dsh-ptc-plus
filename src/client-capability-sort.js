export const CAPABILITY_SORT_COLUMNS = [
  { key: 'name', label: 'member' },
  { key: 'type', label: 'typesColumn' },
  { key: 'source', label: 'sourceColumn' },
  { key: 'availability', label: 'enabledColumn' },
  { key: 'context', label: 'contextColumn' },
]

export function cycleCapabilitySort(current, column) {
  if (current?.column !== column) return { column, direction: 'ascending' }
  return current.direction === 'ascending' ? { column, direction: 'descending' } : null
}

export function capabilitySortDirection(current, column) {
  return current?.column === column ? current.direction : 'none'
}

/** Callers supply their displayed values and existing default presentation order. */
export function sortCapabilityEntries(entries, current, valueFor) {
  if (!current) return [...entries]
  const direction = current.direction === 'descending' ? -1 : 1
  const value = entry => {
    const result = valueFor(entry, current.column)
    return typeof result === 'number' ? result : String(result ?? '').toLowerCase()
  }
  return entries.map((entry, index) => ({ entry, index, value: value(entry) }))
    .sort((a, b) => direction * (a.value < b.value ? -1 : a.value > b.value ? 1 : 0) || a.index - b.index)
    .map(item => item.entry)
}
