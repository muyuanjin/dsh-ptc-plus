/**
 * Column ordering for the capability table.
 *
 * The question is only "in which order does this page state the rows the Host
 * declared". A sort never decides what a row says: it changes neither the saved
 * column nor this session's record, and it is not part of the read. The default
 * — nothing sorted — is the supply order the read stated, so a third click
 * returns the table to the order it arrived in rather than leaving the reader to
 * reconstruct it.
 */

/** The next state of one column's ordering: ascending, then descending, then none. */
export function cycleCapabilitySort(current, column) {
  if (current?.column !== column) return { column, direction: 'ascending' }
  return current.direction === 'ascending' ? { column, direction: 'descending' } : null
}

/** What `aria-sort` states for one column, using the vocabulary that attribute owns. */
export function capabilitySortDirection(current, column) {
  return current?.column === column ? current.direction : 'none'
}

/**
 * Order rows by their displayed values.
 *
 * Values come from the caller because they are what the reader compares: a type
 * orders by the word in the badge and a source by its label, not by the field a
 * translation is derived from. Ties keep the order they arrived in, so equal
 * rows never reshuffle between two renders.
 */
export function sortCapabilityEntries(entries, current, valueFor) {
  if (!current) return [...entries]
  const direction = current.direction === 'descending' ? -1 : 1
  const value = entry => {
    const result = valueFor(entry, current.column)
    return typeof result === 'number' ? result : String(result ?? '').toLowerCase()
  }
  return entries.map((entry, index) => ({ entry, index, value: value(entry) }))
    .sort((left, right) => direction * (left.value < right.value ? -1 : left.value > right.value ? 1 : 0)
      || left.index - right.index)
    .map(item => item.entry)
}
