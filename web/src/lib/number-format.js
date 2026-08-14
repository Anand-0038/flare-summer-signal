const INTEGER_FORMATTER = new Intl.NumberFormat('en-US')

export function formatInteger(value) {
  if (value === null || value === undefined || value === '') return '—'

  const text = typeof value === 'bigint' ? value.toString() : String(value).trim()
  if (text === '') return '—'

  if (/^-?\d+$/.test(text)) {
    try {
      return INTEGER_FORMATTER.format(BigInt(text))
    } catch {
      // Fall through to numeric formatting for unusual numeric strings.
    }
  }

  const number = Number(text)
  return Number.isFinite(number) ? number.toLocaleString('en-US') : '—'
}
