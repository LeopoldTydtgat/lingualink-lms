const EMOJI_UNIT =
  '(?:\\p{Extended_Pictographic}\\u{FE0F}?\\p{Emoji_Modifier}?(?:\\u{200D}\\p{Extended_Pictographic}\\u{FE0F}?\\p{Emoji_Modifier}?)*)' +
  '|(?:[\\u{1F1E6}-\\u{1F1FF}]{2})'

const EMOJI_ONLY_REGEX = new RegExp(`^(?:${EMOJI_UNIT}|\\s)+$`, 'u')

export function isEmojiOnly(html: string): boolean {
  const stripped = html.replace(/<[^>]*>/g, '').trim()
  return EMOJI_ONLY_REGEX.test(stripped) && stripped.length <= 8
}
