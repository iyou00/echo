export const MUSIC_LANGUAGE_VALUES = [
  '华语',
  '粤语',
  '英语',
  '韩语',
  '日语',
  '法语',
  '德语',
  '西班牙语',
  '俄语',
  '泰语',
  '葡萄牙语',
  '意大利语',
] as const

export type MusicLanguage = typeof MUSIC_LANGUAGE_VALUES[number]

interface MusicLanguageProfile {
  aliases: RegExp
  searchTerms: string[]
  genre: string
}

const LANGUAGE_PROFILES: Record<MusicLanguage, MusicLanguageProfile> = {
  华语: {
    aliases: /华语|中文歌曲?|国语|普通话|大陆歌曲?|中国歌曲?|mandopop/i,
    searchTerms: ['华语歌曲', '中文歌曲', 'Mandopop'],
    genre: '华语流行',
  },
  粤语: {
    aliases: /粤语|广东歌曲?|港乐|cantopop/i,
    searchTerms: ['粤语歌曲', '广东歌', 'Cantopop'],
    genre: '粤语流行',
  },
  英语: {
    aliases: /英语歌曲?|英文歌曲?|欧美歌曲?|英美|english\s*(?:song|music)?/i,
    searchTerms: ['英文歌曲', '欧美流行', 'English songs'],
    genre: '欧美流行',
  },
  韩语: {
    aliases: /韩语|韩文歌曲?|韩国歌曲?|韩团|k[\s-]?pop/i,
    searchTerms: ['韩国歌曲', 'K-pop', '韩语歌曲'],
    genre: 'K-pop',
  },
  日语: {
    aliases: /日语|日文歌曲?|日本歌曲?|j[\s-]?pop/i,
    searchTerms: ['日本歌曲', 'J-pop', '日语歌曲'],
    genre: '日语流行',
  },
  法语: {
    aliases: /法语|法文歌曲?|法国歌曲?|french\s*(?:song|music|pop)?/i,
    searchTerms: ['法国歌曲', 'French pop', '法语歌曲'],
    genre: '法语流行',
  },
  德语: {
    aliases: /德语|德文歌曲?|德国歌曲?|german\s*(?:song|music|pop)?/i,
    searchTerms: ['德国歌曲', 'German pop', '德语歌曲'],
    genre: '德语流行',
  },
  西班牙语: {
    aliases: /西班牙语|西语歌曲?|西班牙歌曲?|拉丁西语|spanish\s*(?:song|music|pop)?/i,
    searchTerms: ['西班牙语歌曲', 'Latin pop', 'Spanish songs'],
    genre: '西班牙语流行',
  },
  俄语: {
    aliases: /俄语|俄文歌曲?|俄罗斯歌曲?|russian\s*(?:song|music|pop)?/i,
    searchTerms: ['俄罗斯歌曲', 'Russian pop', '俄语歌曲'],
    genre: '俄语流行',
  },
  泰语: {
    aliases: /泰语|泰文歌曲?|泰国歌曲?|t[\s-]?pop|thai\s*(?:song|music|pop)?/i,
    searchTerms: ['泰国歌曲', 'T-pop', '泰语歌曲'],
    genre: '泰语流行',
  },
  葡萄牙语: {
    aliases: /葡萄牙语|葡语歌曲?|葡萄牙歌曲?|巴西葡语|portuguese\s*(?:song|music|pop)?/i,
    searchTerms: ['葡萄牙语歌曲', 'Brazilian pop', 'Portuguese songs'],
    genre: '葡萄牙语流行',
  },
  意大利语: {
    aliases: /意大利语|意语歌曲?|意大利歌曲?|italian\s*(?:song|music|pop)?/i,
    searchTerms: ['意大利歌曲', 'Italian pop', '意大利语歌曲'],
    genre: '意大利语流行',
  },
}

export function isMusicLanguage(value: unknown): value is MusicLanguage {
  return typeof value === 'string' && (MUSIC_LANGUAGE_VALUES as readonly string[]).includes(value)
}

export function detectMusicLanguage(text: string): MusicLanguage | undefined {
  return MUSIC_LANGUAGE_VALUES.find((language) => LANGUAGE_PROFILES[language].aliases.test(text))
}

export function musicLanguageSearchTerms(language: string | undefined): string[] {
  return isMusicLanguage(language) ? [...LANGUAGE_PROFILES[language].searchTerms] : []
}

export function musicLanguageGenre(language: string | undefined): string | undefined {
  return isMusicLanguage(language) ? LANGUAGE_PROFILES[language].genre : undefined
}

export function stripMusicLanguageCues(text: string): string {
  let result = text
  for (const language of MUSIC_LANGUAGE_VALUES) {
    result = result.replace(new RegExp(LANGUAGE_PROFILES[language].aliases.source, 'gi'), ' ')
  }
  return result.replace(/\s+/g, ' ').trim()
}
