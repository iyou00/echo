import { describe, expect, it } from 'vitest'
import type { Track, TrackSemantic } from '../../../types/ipc'
import { parseIntent } from './intent'
import {
  detectMusicLanguage,
  MUSIC_LANGUAGE_VALUES,
  musicLanguageSearchTerms,
  stripMusicLanguageCues,
  type MusicLanguage,
} from './language'
import { recommendationRecallTestHelpers } from './recall'
import { recommendationTestHelpers } from '../recommendation'
import { chatIntentTestHelpers, classifyFallbackChatIntent } from '../../skills/intent/chat'

const languageExamples: Array<[string, MusicLanguage]> = [
  ['推荐一首中文歌', '华语'],
  ['来点广东歌', '粤语'],
  ['找英文歌曲', '英语'],
  ['韩国歌曲', '韩语'],
  ['J-pop 来一首', '日语'],
  ['法国歌曲', '法语'],
  ['德国歌曲', '德语'],
  ['西班牙语歌曲', '西班牙语'],
  ['俄罗斯歌曲', '俄语'],
  ['泰国歌曲', '泰语'],
  ['葡萄牙语歌曲', '葡萄牙语'],
  ['意大利歌曲', '意大利语'],
]

function semantic(language: MusicLanguage): TrackSemantic {
  return {
    language,
    genres: [],
    moods: ['陪伴'],
    scenes: [],
    energy: 0.5,
    tempo: 'medium',
    familiarity: 'safe',
    confidence: 0.8,
  }
}

describe('music language routing and recall', () => {
  it.each(languageExamples)('detects %s as %s', (text, language) => {
    expect(detectMusicLanguage(text)).toBe(language)
    expect(parseIntent(text, { inferEntities: false }).language).toBe(language)
    expect(classifyFallbackChatIntent(text).recommendationIntent.language).toBe(language)
    expect(musicLanguageSearchTerms(language).length).toBeGreaterThanOrEqual(3)
  })

  it('keeps the supported language registry and aliases in sync', () => {
    expect(new Set(languageExamples.map(([, language]) => language))).toEqual(new Set(MUSIC_LANGUAGE_VALUES))
  })

  it('removes language and weather command noise before building search keywords', () => {
    const query = '找一首适合今天天气的歌，韩国歌曲'
    const intent = parseIntent(query, { inferEntities: false })
    const compact = recommendationRecallTestHelpers.compactIntentQuery(query)
    const keyword = recommendationRecallTestHelpers.keywordFromIntent(intent, { daySeed: '2026-08-10' }, {})
    const searches = recommendationRecallTestHelpers.buildLanguageSearchQueries(intent)

    expect(stripMusicLanguageCues(query)).not.toContain('韩国歌曲')
    expect(compact).toBe('')
    expect(keyword).toContain('韩国歌曲')
    expect(keyword).not.toContain('今天天气')
    expect(searches).toContain('K-pop')
    expect(searches).toContain('韩国歌曲')
  })

  it('keeps only the explicitly requested language for generic language requests', () => {
    const intent = parseIntent('推荐一首韩语歌', { inferEntities: false })
    const tracks: Track[] = [
      { id: 'ko', title: 'Korean track', artist: 'K', semantic: semantic('韩语') },
      { id: 'en', title: 'English track', artist: 'E', semantic: semantic('英语') },
    ]

    const filtered = recommendationTestHelpers.constrainByRequestedLanguage(tracks, intent)

    expect(filtered.map((track) => track.id)).toEqual(['ko'])
  })

  it('accepts an extended language from the LLM router', () => {
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'mood_request',
      wantsMusic: true,
      confidence: 0.96,
      language: '法语',
      targetCount: 1,
      evidence: ['法语歌曲'],
    }), '推荐一首法语歌曲', {})

    expect(route?.kind).toBe('mood_request')
    expect(route?.override?.language).toBe('法语')
  })
})
