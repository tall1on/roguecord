const REGIONAL_INDICATOR_START = 0x1f1e6
const REGIONAL_INDICATOR_END = 0x1f1ff
const ASCII_A_CODE = 65

export const getFlagEmojiCountryCode = (value: string | null | undefined): string | null => {
  const trimmedValue = value?.trim() ?? ''
  if (!trimmedValue) {
    return null
  }

  const codePoints = Array.from(trimmedValue)
  if (codePoints.length !== 2) {
    return null
  }

  const countryCode = codePoints
    .map((character) => {
      const codePoint = character.codePointAt(0)
      if (codePoint === undefined || codePoint < REGIONAL_INDICATOR_START || codePoint > REGIONAL_INDICATOR_END) {
        return null
      }

      return String.fromCharCode(ASCII_A_CODE + codePoint - REGIONAL_INDICATOR_START)
    })
    .join('')

  return /^[A-Z]{2}$/.test(countryCode) ? countryCode.toLowerCase() : null
}

export const isFlagEmoji = (value: string | null | undefined): boolean => {
  return getFlagEmojiCountryCode(value) !== null
}

export const getFlagEmojiImageUrl = (value: string | null | undefined): string | null => {
  const countryCode = getFlagEmojiCountryCode(value)
  if (!countryCode) {
    return null
  }

  return flagImageModules[`../node_modules/flag-icons/flags/4x3/${countryCode}.svg`] ?? null
}
const flagImageModules = import.meta.glob('../node_modules/flag-icons/flags/4x3/*.svg', {
  eager: true,
  import: 'default'
}) as Record<string, string>
