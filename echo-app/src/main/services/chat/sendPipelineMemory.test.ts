import { describe, expect, it, vi } from 'vitest'
import { chatSendPipelineTestHelpers } from './sendPipeline'
import { classifyChatIntent } from './intent'
import { chatIntentTestHelpers } from '../../skills/intent/chat'
import { resolveMusicEntitiesFromText } from '../../skills/music/entityResolver'
import { musicSearchTestHelpers } from '../../skills/music/search'
import type { Track } from '../../../types/ipc'
import {
  clearChatMusicSession,
  inferSessionAffirmationAction,
  rememberChatMusicSession,
  resolveSessionMusicFollowUp,
} from './sessionContext'
import { handleCurrentTrackFeedback, trackFeedbackTestHelpers } from './trackFeedback'
import { responseStageTestHelpers } from './responseStage'
import { hasMusicActionIntent } from './candidateStage'
import {
  clearPendingDirectSongState,
  resolvePendingMusicEntityReply,
  setPendingMusicEntityClarification,
} from './pendingIntents'

describe('chat weak memory signal boundaries', () => {
  it('maps music focus words to vibe signals instead of artists', () => {
    const voice = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢人声更近一点的歌')
    expect(voice?.kind).toBe('reinforce_vibe')
    expect(voice?.payload.target).toBe('人声')

    const melody = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢旋律舒服一点的歌')
    expect(melody?.kind).toBe('reinforce_vibe')
    expect(melody?.payload.target).toBe('旋律')
  })

  it('still treats explicit artist preference as artist signal', () => {
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢陈奕迅的歌')
    expect(signal?.kind).toBe('like_artist')
    expect(signal?.payload.target).toBe('陈奕迅')
  })

  it('does not attach current-track rejection wording to a newly requested song', () => {
    const currentTrack = { id: 'current', title: '沉溺', artist: '陈默之', source: 'netease' } as Track
    const intent = {
      ...classifyChatIntent('这首歌不好听，我要听王菲的主角', { currentTrack }),
      kind: 'direct_song' as const,
      wantsMusic: true,
      artistQuery: '王菲',
      seedTitle: '主角',
    }

    expect(chatSendPipelineTestHelpers.shouldRecordCurrentTrackRejectionAlongsideExternalRequest(
      '这首歌不好听，我要听王菲的主角',
      intent,
      currentTrack,
    )).toBe(true)
    expect(chatSendPipelineTestHelpers.buildChatTasteSignal(
      '这首歌不好听，我要听王菲的主角',
      intent,
      currentTrack,
    )).toBeNull()
  })

  it('does not treat a disliked external artist as current-track rejection', () => {
    const currentTrack = { id: 'current', title: '沉溺', artist: '陈默之', source: 'netease' } as Track
    const intent = {
      ...classifyChatIntent('我不喜欢王菲，想听陈奕迅', { currentTrack }),
      kind: 'artist_request' as const,
      wantsMusic: true,
      artistQuery: '陈奕迅',
    }

    expect(chatSendPipelineTestHelpers.shouldRecordCurrentTrackRejectionAlongsideExternalRequest(
      '我不喜欢王菲，想听陈奕迅',
      intent,
      currentTrack,
    )).toBe(false)
  })

  it('keeps explicit dislike attached to the requested song when it matches the current track', () => {
    const currentTrack = { id: 'current', title: '主角', artist: '王菲', source: 'netease' } as Track
    const intent = {
      ...classifyChatIntent('王菲的主角这首歌不好听', { currentTrack }),
      kind: 'direct_song' as const,
      wantsMusic: true,
      artistQuery: '王菲',
      seedTitle: '主角',
    }
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('王菲的主角这首歌不好听', intent, currentTrack)

    expect(chatSendPipelineTestHelpers.shouldRecordCurrentTrackRejectionAlongsideExternalRequest(
      '王菲的主角这首歌不好听',
      intent,
      currentTrack,
    )).toBe(false)
    expect(signal).toMatchObject({
      kind: 'unlike_track',
      payload: {
        artist: '王菲',
        title: '主角',
      },
    })
  })

  it('keeps precise compound sound dislikes narrower than their broad genre', () => {
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('少推电子音墙，我现在听这个会烦')

    expect(signal?.kind).toBe('unlike_vibe')
    expect(signal?.payload.target).toBe('电子音墙')
  })

  it('maps emotional music direction dislikes to vibe signals instead of artists', () => {
    const sad = chatSendPipelineTestHelpers.buildChatTasteSignal('我不喜欢太悲伤的歌')
    const heavy = chatSendPipelineTestHelpers.buildChatTasteSignal('少推压抑一点的音乐')

    expect(sad?.kind).toBe('unlike_vibe')
    expect(sad?.payload.target).toBe('悲伤')
    expect(heavy?.kind).toBe('unlike_vibe')
    expect(heavy?.payload.target).toBe('压抑')
  })

  it('maps positive emotional music directions to vibe signals instead of artists', () => {
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我最近喜欢明亮一点的歌')

    expect(signal?.kind).toBe('reinforce_vibe')
    expect(signal?.payload.target).toBe('明亮')
  })

  it('records explicit warm music preference as a durable vibe signal', () => {
    for (const text of ['最近喜欢温暖一点的歌', '暖心一点的可以多来点']) {
      const signal = chatSendPipelineTestHelpers.buildChatTasteSignal(text)

      expect(signal).toMatchObject({
        kind: 'reinforce_vibe',
        payload: expect.objectContaining({
          target: expect.stringMatching(/温暖|暖心/),
        }),
      })
    }
  })

  it('records clear emotional companionship text as a recent context event', () => {
    const cold = chatSendPipelineTestHelpers.buildChatTasteSignal('我有点冷')
    const tired = chatSendPipelineTestHelpers.buildChatTasteSignal('今天好累，先陪我说两句')

    expect(cold).toMatchObject({
      kind: 'event_started',
      payload: {
        target: '觉得有点冷',
        weight: 0.32,
      },
    })
    expect(tired).toMatchObject({
      kind: 'event_started',
      payload: {
        target: '觉得累',
      },
    })
  })

  it('ends recent emotional context with natural recovery wording', () => {
    const cold = chatSendPipelineTestHelpers.buildChatTasteSignal('不冷了，刚才那阵过去了')
    const tired = chatSendPipelineTestHelpers.buildChatTasteSignal('休息好了，现在有力气了')
    const generic = chatSendPipelineTestHelpers.buildChatTasteSignal('好多了，我们继续听歌吧')

    expect(cold).toMatchObject({
      kind: 'event_ended',
      payload: {
        target: '冷',
      },
    })
    expect(tired).toMatchObject({
      kind: 'event_ended',
      payload: {
        target: '累',
      },
    })
    expect(generic).toMatchObject({
      kind: 'event_ended',
      payload: {
        target: '',
      },
    })
  })

  it('keeps explicit no-music chat from creating emotion events', () => {
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我今天不想听歌，只想聊聊')

    expect(signal).toBeNull()
  })

  it('keeps ordinary genre preferences as genre signals', () => {
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢民谣的歌')

    expect(signal?.kind).toBe('like_genre')
    expect(signal?.payload.target).toBe('民谣')
  })

  it('keeps explicit track dislike at track scope', () => {
    const intent = {
      ...classifyChatIntent('我不喜欢王菲的《主角》'),
      artistQuery: '王菲',
      seedTitle: '主角',
    }
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我不喜欢王菲的《主角》', intent)

    expect(signal?.kind).toBe('unlike_track')
    expect(signal?.payload.artist).toBe('王菲')
    expect(signal?.payload.title).toBe('主角')
  })

  it('never treats negative track wording as a positive preference', () => {
    const intent = classifyChatIntent('我不喜欢王菲的《主角》')
    expect(chatSendPipelineTestHelpers.isPositiveExplicitTrackPreference(
      '我不喜欢王菲的《主角》',
      intent,
      null,
    )).toBe(false)
  })

  it('does not attach explicit external song preference to the current track', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('王菲的主角这个首歌，我还蛮喜欢听的', { currentTrack })

    expect(intent.kind).not.toBe('feedback_current_track')
    expect(intent.artistQuery).toBe('王菲')
    expect(intent.seedTitle).toBe('主角')
  })

  it('treats unquoted external song preference as track memory', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('我喜欢陈奕迅的冷夜', { currentTrack })

    expect(intent.kind).toBe('casual_chat')
    expect(intent.wantsMusic).toBe(false)
    expect(intent.artistQuery).toBe('陈奕迅')
    expect(intent.seedTitle).toBe('冷夜')
    expect(chatSendPipelineTestHelpers.isPositiveExplicitTrackPreference(
      '我喜欢陈奕迅的冷夜',
      intent,
      currentTrack,
    )).toBe(true)
    expect(chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢陈奕迅的冷夜', intent, currentTrack)).toBeNull()
  })

  it('keeps unquoted external song dislike at track scope', () => {
    const intent = classifyChatIntent('我不喜欢陈默之的沉溺')
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我不喜欢陈默之的沉溺', intent)

    expect(intent.artistQuery).toBe('陈默之')
    expect(intent.seedTitle).toBe('沉溺')
    expect(signal?.kind).toBe('unlike_track')
    expect(signal?.payload.artist).toBe('陈默之')
    expect(signal?.payload.title).toBe('沉溺')
  })

  it('keeps explicit disliked track memory when the same sentence asks for another artist', () => {
    const intent = {
      ...classifyChatIntent('王菲的主角这首歌不好听，我想听陈奕迅'),
      kind: 'artist_request' as const,
      wantsMusic: true,
      artistQuery: '陈奕迅',
      seedTitle: undefined,
    }
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('王菲的主角这首歌不好听，我想听陈奕迅', intent)

    expect(signal?.kind).toBe('unlike_track')
    expect(signal?.payload.artist).toBe('王菲')
    expect(signal?.payload.title).toBe('主角')
  })

  it('keeps explicit liked track memory when the same sentence asks for another artist', () => {
    const intent = {
      ...classifyChatIntent('我喜欢王菲的主角，但现在想听陈奕迅'),
      kind: 'artist_request' as const,
      wantsMusic: true,
      artistQuery: '陈奕迅',
      seedTitle: undefined,
    }
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢王菲的主角，但现在想听陈奕迅', intent)

    expect(signal?.kind).toBe('like_track')
    expect(signal?.payload.artist).toBe('王菲')
    expect(signal?.payload.title).toBe('主角')
  })

  it('keeps obvious current track replacement as current feedback', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('这首歌不好听，换一首激情一点的', { currentTrack })

    expect(intent.kind).toBe('feedback_current_track')
    expect(intent.feedbackAction).toBe('not_right')
  })

  it('keeps fallback current-track dislike with a clear direction as a replacement action', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('这首不太对，激情一点', { currentTrack })

    expect(intent.kind).toBe('feedback_current_track')
    expect(intent.feedbackAction).toBe('not_right')
    expect(intent.wantsMusic).toBe(true)
  })

  it('treats bare song preference as preference instead of current feedback', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('我喜欢《主角》这首歌', { currentTrack })

    expect(intent.kind).not.toBe('feedback_current_track')
    expect(intent.seedTitle).toBe('主角')
  })

  it('classifies an explicit reference song as a similarity request', () => {
    const intent = classifyChatIntent('类似大鱼海棠这首歌的歌曲推荐下')

    expect(intent.kind).toBe('similar_to_track')
    expect(intent.wantsMusic).toBe(true)
    expect(intent.seedTitle).toBe('大鱼海棠')
  })

  it('keeps an explicit similarity anchor out of the previous music session', () => {
    rememberChatMusicSession({
      sourceText: '给我来一首歌',
      intentKind: 'mood_request',
      tracks: [{
        id: 'previous',
        title: '上一轮推荐',
        artist: '旧歌手',
      }],
    })

    try {
      expect(resolveSessionMusicFollowUp('类似大鱼海棠这首歌的歌曲推荐下')).toEqual({ kind: 'none' })
    } finally {
      clearChatMusicSession()
    }
  })

  it('keeps weather and Echo identity as first-class routes', () => {
    expect(classifyChatIntent('今天外面几度？').kind).toBe('weather')
    expect(classifyChatIntent('你是谁，平时能做什么？').kind).toBe('identity')
    expect(classifyChatIntent('雨天适合听什么歌？').kind).toBe('scene_request')
  })

  it('recognizes broad selection verbs as music actions', () => {
    expect(classifyChatIntent('你帮我挑一首').wantsMusic).toBe(true)
    expect(classifyChatIntent('随便选一首吧').wantsMusic).toBe(true)
  })

  it('keeps fallback routing conservative for non-music uses of recommendation words', () => {
    expect(classifyChatIntent('推荐一本书').wantsMusic).toBe(false)
    expect(classifyChatIntent('你会推理吗').wantsMusic).toBe(false)
    expect(classifyChatIntent('找一首诗').wantsMusic).toBe(false)
    expect(classifyChatIntent('推荐一首诗').wantsMusic).toBe(false)
    expect(classifyChatIntent('分享几首古诗').wantsMusic).toBe(false)
    expect(classifyChatIntent('有什么好听的播客吗').wantsMusic).toBe(false)
    expect(classifyChatIntent('有什么好看的电影吗').wantsMusic).toBe(false)
    expect(classifyChatIntent('推荐一首歌').wantsMusic).toBe(true)
  })

  it('inherits an artist only from a recent user topic after an assistant offer', () => {
    const context = {
      recentDialog: [
        { role: 'user' as const, content: '陈默之有哪些歌适合现在听' },
        { role: 'assistant' as const, content: '要我来挑一首开始放？' },
      ],
    }
    const inherited = chatIntentTestHelpers.applyRecentMusicContext(
      classifyChatIntent('你帮我挑一首'),
      context,
    )

    expect(inherited.kind).toBe('artist_request')
    expect(inherited.artistQuery).toBe('陈默之')
    expect(inherited.wantsMusic).toBe(true)
  })

  it('lets a bare affirmation inherit the recent user artist after an assistant music offer', () => {
    const context = {
      recentDialog: [
        { role: 'user' as const, content: '陈默之有哪些歌适合现在听' },
        { role: 'assistant' as const, content: '要不要我来挑一首开始放？' },
      ],
    }
    const inherited = chatIntentTestHelpers.applyRecentMusicContext(
      classifyChatIntent('可以'),
      context,
    )

    expect(inherited.kind).toBe('artist_request')
    expect(inherited.artistQuery).toBe('陈默之')
    expect(inherited.wantsMusic).toBe(true)
  })

  it('inherits the recent artist from natural follow-up selection wording', () => {
    const context = {
      recentDialog: [
        { role: 'user' as const, content: '陈默之有哪些歌适合现在听' },
        { role: 'assistant' as const, content: '要不要我来挑一首开始放？' },
      ],
    }

    for (const text of ['可以，那你挑一首', '那就你挑一首', '好啊，随便来一首']) {
      const inherited = chatIntentTestHelpers.applyRecentMusicContext(
        classifyChatIntent(text),
        context,
      )

      expect(inherited.kind).toBe('artist_request')
      expect(inherited.artistQuery).toBe('陈默之')
      expect(inherited.wantsMusic).toBe(true)
    }
  })

  it('keeps recent artist context when the llm route is a generic music action', () => {
    const context = {
      recentDialog: [
        { role: 'user' as const, content: '陈默之有哪些歌适合现在听' },
        { role: 'assistant' as const, content: '要不要我来挑一首开始放？' },
      ],
    }
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.94,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":["挑一首"]}',
      '你帮我挑一首',
      context,
    )
    const inherited = chatIntentTestHelpers.resolveInferredChatRoute('你帮我挑一首', route, context)

    expect(inherited?.kind).toBe('artist_request')
    expect(inherited?.artistQuery).toBe('陈默之')
    expect(inherited?.wantsMusic).toBe(true)
    expect(inherited?.routeSource).toBe('llm')
  })

  it('arms session search for natural assistant offers to pick or find a track', () => {
    for (const reply of [
      '你想先试哪一首，还是我来找一首开始放？',
      '要不要我来挑一首开始放？',
      '我可以再帮你选一首。',
    ]) {
      expect(inferSessionAffirmationAction(reply)).toBe('search')
    }
  })

  it('turns natural pick-one follow-ups into session searches', () => {
    rememberChatMusicSession({
      sourceText: '陈默之有哪些歌适合现在听',
      intentKind: 'artist_request',
      artistQuery: '陈默之',
      tracks: [{
        title: '沉溺',
        artist: '陈默之',
        source: 'netease',
      }],
      affirmationAction: 'search',
    })

    try {
      const followUp = resolveSessionMusicFollowUp('你帮我挑一首')

      expect(followUp.kind).toBe('search')
      if (followUp.kind === 'search') {
        expect(followUp.query).toContain('陈默之')
        expect(followUp.excludeTracks.map((track) => track.title)).toEqual(['沉溺'])
      }
    } finally {
      clearChatMusicSession()
    }
  })

  it('keeps a bare affirmation casual when there is no assistant music offer', () => {
    const context = {
      recentDialog: [
        { role: 'user' as const, content: '陈默之有哪些歌适合现在听' },
        { role: 'assistant' as const, content: '他的声音更适合慢一点听。' },
      ],
    }
    const inherited = chatIntentTestHelpers.applyRecentMusicContext(
      classifyChatIntent('可以'),
      context,
    )

    expect(inherited.kind).toBe('casual_chat')
    expect(inherited.wantsMusic).toBe(false)
  })

  it('accepts a contextual artist only when a recent user mentioned it', () => {
    const content = '{"kind":"artist_request","wantsMusic":true,"confidence":0.96,"artistQuery":"陈默之","seedTitle":null,"targetCount":1}'
    expect(chatIntentTestHelpers.parseChatRouteContent(content, '你帮我挑一首', {
      recentDialog: [
        { role: 'user', content: '陈默之有哪些歌适合现在听' },
        { role: 'assistant', content: '要我来挑一首开始放？' },
      ],
    })?.override?.artistQuery).toBe('陈默之')
    expect(chatIntentTestHelpers.parseChatRouteContent(content, '你帮我挑一首', {
      recentDialog: [
        { role: 'assistant', content: '陈默之的歌可以试试。' },
      ],
    })?.override?.artistQuery).toBeUndefined()
  })

  it('does not leak a recent artist into a fresh music request', () => {
    const content = '{"kind":"mood_request","wantsMusic":true,"confidence":0.94,"artistQuery":"陈默之","seedTitle":null,"targetCount":1,"language":"粤语"}'
    const route = chatIntentTestHelpers.parseChatRouteContent(content, '推荐点粤语歌', {
      recentDialog: [
        { role: 'user', content: '陈默之有哪些歌' },
        { role: 'assistant', content: '他的歌更偏温和。' },
      ],
    })

    expect(route?.override?.artistQuery).toBeUndefined()
    expect(route?.override?.language).toBe('粤语')
  })

  it('removes a concrete recommendation claim when no card can be bound', () => {
    const content = responseStageTestHelpers.enforceTrackClaimContract(
      '这首《沉溺》，前奏轻，正好接黄昏。',
      [],
    )

    expect(content).not.toContain('沉溺')
    expect(content).toContain('没拿到能播放的版本')
  })

  it('removes unbound playback promises without title brackets', () => {
    for (const reply of [
      '行，先放沉溺，前奏正好接这个时间点。',
      '不如试试 Part Time Lover，先听开头。',
      '行，这首前奏一出来就挺有冲击力的，先听听看合不合你现在的感觉。',
    ]) {
      const content = responseStageTestHelpers.enforceTrackClaimContract(reply, [])
      expect(content).toContain('没拿到能播放的版本')
      expect(content).not.toBe(reply)
    }
  })

  it('does not rewrite ordinary conversation when no music action is expected', () => {
    const reply = '推荐这件事可以慢慢来，你先说说现在的心情。'
    expect(responseStageTestHelpers.enforceTrackClaimContract(reply, [], false)).toBe(reply)
  })

  it('accepts LLM music entities only when the user actually mentioned them', () => {
    const valid = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"artist_request","wantsMusic":true,"confidence":0.96,"artistQuery":"陈奕迅","seedTitle":null,"targetCount":1}',
      '你随便来一首陈奕迅的歌曲吧',
      {},
    )
    expect(valid?.kind).toBe('artist_request')
    expect(valid?.override?.artistQuery).toBe('陈奕迅')

    const hallucinated = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.98,"artistQuery":"王菲","seedTitle":"红豆","targetCount":1}',
      '这个时候有什么值得听的吗',
      {},
    )
    expect(hallucinated?.kind).toBe('mood_request')
    expect(hallucinated?.override?.artistQuery).toBeUndefined()
    expect(hallucinated?.override?.seedTitle).toBeUndefined()
  })

  it('treats described short song titles as executable direct song requests', () => {
    const text = '最近枪火这首歌蛮火的，听听看'
    const fallback = classifyChatIntent(text, {
      currentTrack: {
        id: 'current',
        title: 'Sonata No. 8 in C Minor',
        artist: 'Arthur Rubinstein',
      } as Track,
    })
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.96,"seedTitle":"枪火","targetCount":1}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(fallback.kind).toBe('direct_song')
    expect(fallback.seedTitle).toBe('枪火')
    expect(resolved?.kind).toBe('direct_song')
    expect(resolved?.seedTitle).toBe('枪火')
  })

  it('requires explicit evidence for very short Chinese song titles', () => {
    const hallucinated = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.96,"seedTitle":"爱","targetCount":1}',
      '我爱听安静一点的歌',
      {},
    )
    const explicit = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.96,"seedTitle":"爱","targetCount":1}',
      '我想听爱',
      {},
    )

    expect(hallucinated?.override?.seedTitle).toBeUndefined()
    expect(explicit?.override?.seedTitle).toBe('爱')
  })

  it('builds the final command from the LLM route without a rule baseline', () => {
    const text = '最近写论文写得好累'
    expect(classifyChatIntent(text).kind).toBe('out_of_scope')
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"casual_chat","wantsMusic":false,"confidence":0.91,"targetCount":1}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(resolved?.kind).toBe('casual_chat')
    expect(resolved?.routeSource).toBe('llm')
  })

  it('rejects unsafe current-track feedback and leaves it for fallback', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
    } as Track
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":false,"confidence":0.94,"feedbackAction":"not_right"}',
      '我今天有点冷',
      { currentTrack },
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute('我今天有点冷', route, { currentTrack })).toBeNull()
  })

  it('clears a rule-only title when the LLM resolves an artist request', () => {
    const text = '你随便来一首陈奕迅的歌曲吧'
    const baseline = classifyChatIntent(text)
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"artist_request","wantsMusic":true,"confidence":0.96,"artistQuery":"陈奕迅","seedTitle":null,"targetCount":1}',
      text,
      {},
    )
    expect(route).not.toBeNull()
    const routed = chatIntentTestHelpers.applyInferredChatRoute(baseline, route!, {})

    expect(routed.kind).toBe('artist_request')
    expect(routed.artistQuery).toBe('陈奕迅')
    expect(routed.seedTitle).toBeUndefined()
  })

  it('rejects current-track feedback without a concrete action', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
    } as Track
    expect(chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":false,"confidence":0.94}',
      '这首我有点说不准',
      { currentTrack },
    )).toBeNull()
  })

  it('uses explicit feedback wording to correct a conflicting model action', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
    } as Track
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":false,"confidence":0.94,"feedbackAction":"not_right"}',
      '这首不错，我挺喜欢',
      { currentTrack },
    )
    expect(route?.feedbackAction).toBe('favorite')
  })

  it('keeps nuanced negative feedback from becoming a favorite signal', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
    } as Track
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":false,"confidence":0.94,"feedbackAction":"favorite"}',
      '这首我不是很喜欢',
      { currentTrack },
    )
    expect(route?.feedbackAction).toBe('not_right')
  })

  it('records repeated current-track likes without toggling the favorite off', async () => {
    const current: Track = { id: 'current', title: '主角', artist: '王菲', source: 'netease' }
    const intent = classifyChatIntent('这首不错，我挺喜欢', { currentTrack: current })
    const recordFeedback = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const ensureFavorite = vi.fn(async () => ({ favorited: true as const, changed: false, favorites: [current] }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首不错，我挺喜欢', undefined, {
      recordFeedback,
      ensureFavorite,
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement: vi.fn(async () => null),
      playNext: vi.fn(),
    })

    expect(recordFeedback).toHaveBeenCalledWith(current, 'more_like_this', '这首不错，我挺喜欢')
    expect(ensureFavorite).toHaveBeenCalledWith(current)
    expect(result).toMatchObject({
      handled: true,
      tracks: [],
    })
    expect(result.handled && result.content).toContain('本来就在你的喜欢里')
  })

  it('recognizes generic replacement wording as a track change', () => {
    const intent = classifyChatIntent('这首我不喜欢，推荐一首别的', {
      currentTrack: {
        id: 'current',
        title: '为爱痴狂',
        artist: '金志文',
      } as Track,
    })

    expect(trackFeedbackTestHelpers.wantsTrackChange('这首我不喜欢，推荐一首别的', intent)).toBe(true)
  })

  it('falls back to queue when directed replacement search has no playable result', async () => {
    const current: Track = { id: 'current', title: '为爱痴狂', artist: '金志文', source: 'netease' }
    const queued: Track = { id: 'queued', title: '队列歌', artist: '队列歌手', source: 'netease' }
    const generic: Track = { id: 'generic', title: '泛化歌', artist: '泛化歌手', source: 'netease' }
    const intent = classifyChatIntent('这首歌不好听，换一首激情一点的', { currentTrack: current })
    const searchGenericReplacement = vi.fn(async () => generic)
    const playNext = vi.fn(async () => ({
      current: queued,
      position: 0,
      duration: 0,
      status: 'loading' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首歌不好听，换一首激情一点的', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement,
      playNext,
    })

    expect(result.handled).toBe(true)
    expect(result.handled && result.tracks).toEqual([queued])
    expect(searchGenericReplacement).not.toHaveBeenCalled()
    expect(playNext).toHaveBeenCalledOnce()
    expect(result.handled && result.content).toContain('现在换成队列歌手的《队列歌》')
  })

  it('continues the unified candidate pipeline when replacement feedback search has no result', async () => {
    const current: Track = { id: 'current', title: '为爱痴狂', artist: '金志文', source: 'netease' }
    const intent = classifyChatIntent('这首歌不好听，换一首激情一点的', { currentTrack: current })
    const recordFeedback = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const playNext = vi.fn(async () => ({
      current: null,
      position: 0,
      duration: 0,
      status: 'idle' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首歌不好听，换一首激情一点的', undefined, {
      recordFeedback,
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement: vi.fn(async () => null),
      playNext,
    })

    expect(recordFeedback).toHaveBeenCalledWith(current, 'not_right', '这首歌不好听，换一首激情一点的')
    expect(playNext).toHaveBeenCalledOnce()
    expect(result).toEqual({ handled: false })
  })

  it('cleans semantic replacement wording before music search', () => {
    expect(trackFeedbackTestHelpers.buildReplacementQuery('这首歌不好听，换一首激情一点的')).toBe('推荐一首激情的歌')
    expect(trackFeedbackTestHelpers.buildReplacementQuery('这首不太对，激情一点')).toBe('推荐一首激情的歌')
    expect(trackFeedbackTestHelpers.buildReplacementQuery('这首不合适，安静一点')).toBe('推荐一首安静的歌')
    expect(trackFeedbackTestHelpers.buildReplacementQuery('这首太吵了，换一首舒缓一些的')).toBe('推荐一首舒缓的歌')
    expect(trackFeedbackTestHelpers.buildReplacementQuery('换一首王菲的歌')).toBe('推荐一首王菲的歌')
    expect(trackFeedbackTestHelpers.buildReplacementQuery('这首再激情一点')).toBe('推荐一首激情的歌')
    expect(trackFeedbackTestHelpers.buildReplacementQuery('这首稍微安静一点')).toBe('推荐一首安静的歌')
  })

  it('allows semantic feedback with a clear current-track reference', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
    } as Track
    const text = '这首听着让我不舒服'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":false,"confidence":0.94,"feedbackAction":"not_right"}',
      text,
      { currentTrack },
    )
    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack })?.kind).toBe('feedback_current_track')
  })

  it('keeps a casual preference from starting music search', () => {
    const text = '王菲的主角这首歌我喜欢'
    const baseline = classifyChatIntent(text)
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"casual_chat","wantsMusic":false,"confidence":0.94,"artistQuery":"王菲","seedTitle":"主角","targetCount":1}',
      text,
      {},
    )
    expect(route).not.toBeNull()
    const routed = chatIntentTestHelpers.applyInferredChatRoute(baseline, route!, {})

    expect(routed.kind).toBe('casual_chat')
    expect(routed.wantsMusic).toBe(false)
  })

  it('keeps an llm-routed unquoted song preference as memory instead of playback', () => {
    const text = '我喜欢陈奕迅的冷夜'
    const baseline = classifyChatIntent(text)
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"casual_chat","wantsMusic":false,"confidence":0.94,"artistQuery":"陈奕迅","seedTitle":"冷夜","targetCount":1}',
      text,
      {},
    )
    expect(route).not.toBeNull()
    const routed = chatIntentTestHelpers.applyInferredChatRoute(baseline, route!, {})

    expect(routed.kind).toBe('casual_chat')
    expect(routed.wantsMusic).toBe(false)
    expect(routed.artistQuery).toBe('陈奕迅')
    expect(routed.seedTitle).toBe('冷夜')
    expect(chatSendPipelineTestHelpers.isPositiveExplicitTrackPreference(text, routed, null)).toBe(true)
  })

  it('keeps route kind and music action state consistent', () => {
    const music = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":false,"confidence":0.94,"targetCount":1}',
      '这个时候有什么值得听的吗',
      {},
    )
    expect(music?.wantsMusic).toBe(true)
    expect(music?.override?.wantsMusic).toBe(true)

    const casual = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"casual_chat","wantsMusic":true,"confidence":0.94,"targetCount":1}',
      '我今天有点累',
      {},
    )
    expect(casual?.wantsMusic).toBe(false)
    expect(casual?.override?.wantsMusic).toBe(false)
  })

  it('uses the structured LLM command as the primary semantic decision', () => {
    const text = '有什么可以分享给我听的歌吗'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.94,"targetCount":1}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(resolved?.kind).toBe('mood_request')
    expect(resolved?.wantsMusic).toBe(true)
    expect(resolved?.routeSource).toBe('llm')
  })

  it('treats llm-confirmed music requests as executable actions even when the route is generic', () => {
    const resolved = {
      ...classifyChatIntent('你帮我挑一首适合现在听的'),
      kind: 'casual_chat' as const,
      wantsMusic: true,
      routeSource: 'llm' as const,
    }

    expect(hasMusicActionIntent(resolved)).toBe(true)
  })

  it('rejects a model route that would autoplay a pure emotion statement', () => {
    const text = '我今天有点冷'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.94,"targetCount":1}',
      text,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
  })

  it('rejects a model route that drops an explicit music command', () => {
    const text = '你帮我挑一首陈奕迅的歌'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"casual_chat","wantsMusic":false,"confidence":0.94,"artistQuery":"陈奕迅","targetCount":1}',
      text,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
  })

  it('keeps non-music words containing 推 out of music arbitration', () => {
    for (const text of ['你会推理吗', '聊聊音乐推理', '推荐一本书', '找一首诗']) {
      const route = chatIntentTestHelpers.parseChatRouteContent(
        '{"kind":"casual_chat","wantsMusic":false,"confidence":0.94,"targetCount":1}',
        text,
        {},
      )

      expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})?.kind).toBe('casual_chat')
    }
  })

  it('allows a positive replacement request after a negative artist constraint', () => {
    const text = '我不想听周杰伦，推荐点别的歌'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.94,"targetCount":1}',
      text,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})?.kind).toBe('mood_request')
  })

  it('preserves structured low-energy constraints when high-energy words are negated', () => {
    const text = '不要激情的，放点安静的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.96,"targetCount":1,"moods":["放松"],"energy":"low","tempo":"slow","rejectIf":{"maxEnergy":0.72,"forbidTempo":["fast"]}}',
      text,
      {},
    )

    expect(route?.override?.energy).toBe('low')
    expect(route?.override?.tempo).toBe('slow')
    expect(route?.override?.rejectIf?.maxEnergy).toBe(0.72)
    expect(route?.override?.rejectIf?.minEnergy).toBeUndefined()
  })

  it('keeps explicit no-music conversation as casual chat', () => {
    const text = '我今天不想听歌，只想聊聊'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"casual_chat","wantsMusic":false,"confidence":0.94,"targetCount":1}',
      text,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})?.kind).toBe('casual_chat')
  })

  it('turns model uncertainty into a deterministic clarification command', () => {
    const text = '放那个同名的版本'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"clarification_needed","wantsMusic":false,"confidence":0.9,"clarificationReason":"unclear_reference","targetCount":1}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(resolved?.kind).toBe('clarification_needed')
    expect(resolved?.needsClarification?.reason).toBe('unclear_reference')
    expect(resolved?.needsClarification?.prompt).toContain('歌手 + 歌名')
  })

  it('rejects clarification without a concrete music execution cue', () => {
    const text = '我今天有点冷'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"clarification_needed","wantsMusic":false,"confidence":0.92,"clarificationReason":"unclear_reference","targetCount":1}',
      text,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
  })

  it('requires weather and identity evidence before entering static routes', () => {
    const musicText = '雨天适合听什么歌'
    const weatherRoute = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"weather","wantsMusic":false,"confidence":0.95,"targetCount":1}',
      musicText,
      {},
    )
    const identityText = '你帮我挑一首歌'
    const identityRoute = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"identity","wantsMusic":false,"confidence":0.95,"targetCount":1}',
      identityText,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(musicText, weatherRoute, {})).toBeNull()
    expect(chatIntentTestHelpers.resolveInferredChatRoute(identityText, identityRoute, {})).toBeNull()
  })

  it('accepts llm-routed explicit music actions only when the user asks to execute music', () => {
    const playText = '最近枪火这首歌蛮火的，听听看'
    const playRoute = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.96,"seedTitle":"枪火","artistQuery":null,"targetCount":1,"evidence":["枪火","听听看"]}',
      playText,
      {},
    )
    const routedPlay = chatIntentTestHelpers.resolveInferredChatRoute(playText, playRoute, {})

    expect(routedPlay?.kind).toBe('direct_song')
    expect(routedPlay?.wantsMusic).toBe(true)
    expect(routedPlay?.seedTitle).toBe('枪火')
  })

  it('accepts intentConfidence as a compatible llm route confidence field', () => {
    const text = '最近枪火这首歌蛮火的，听听看'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"intentConfidence":0.96,"seedTitle":"枪火","artistQuery":null,"targetCount":1,"evidence":["枪火","听听看"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(routed?.kind).toBe('direct_song')
    expect(routed?.routeSource).toBe('llm')
    expect(routed?.seedTitle).toBe('枪火')
  })

  it('tightens llm music routes with explicit entities before search mode selection', () => {
    const directText = '最近枪火这首歌蛮火的，听听看'
    const directRoute = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.96,"seedTitle":"枪火","artistQuery":null,"targetCount":1,"evidence":["枪火","听听看"]}',
      directText,
      {},
    )
    const artistText = '你随便来一首陈奕迅的歌曲吧'
    const artistRoute = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.96,"artistQuery":"陈奕迅","seedTitle":null,"targetCount":1,"evidence":["陈奕迅","歌曲"]}',
      artistText,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(directText, directRoute, {})?.kind).toBe('direct_song')
    expect(chatIntentTestHelpers.resolveInferredChatRoute(artistText, artistRoute, {})?.kind).toBe('artist_request')
  })

  it('tightens llm current-track replacement routes into feedback before recommendation', () => {
    const currentTrack = {
      id: 'current',
      title: '沉溺',
      artist: '陈默之',
    } as Track
    const text = '这首歌不好听，换一首激情一点的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.96,"targetCount":1,"moods":["清醒","热烈"],"energy":"high","tempo":"fast","evidence":["这首","不好听","换一首","激情"]}',
      text,
      { currentTrack },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack })

    expect(resolved?.kind).toBe('feedback_current_track')
    expect(resolved?.feedbackAction).toBe('not_right')
    expect(resolved?.wantsMusic).toBe(true)
    expect(resolved?.recommendationIntent.energy).toBe('high')
  })

  it('keeps explicit external song requests out of current-track feedback routing', () => {
    const currentTrack = {
      id: 'current',
      title: '沉溺',
      artist: '陈默之',
    } as Track
    const text = '这首歌不好听，我要听王菲的主角'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":true,"confidence":0.94,"artistQuery":"王菲","seedTitle":"主角","targetCount":1,"feedbackAction":"not_right","evidence":["这首","不好听","王菲","主角"]}',
      text,
      { currentTrack },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack })

    expect(resolved?.kind).toBe('direct_song')
    expect(resolved?.feedbackAction).toBeUndefined()
    expect(resolved?.artistQuery).toBe('王菲')
    expect(resolved?.seedTitle).toBe('主角')
    expect(resolved?.wantsMusic).toBe(true)
  })

  it('keeps pure current-track dislike as feedback without a replacement action', () => {
    const currentTrack = {
      id: 'current',
      title: '沉溺',
      artist: '陈默之',
    } as Track
    const text = '这首歌不好听'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","confidence":0.94,"targetCount":1,"feedbackAction":"not_right","evidence":["这首","不好听"]}',
      text,
      { currentTrack },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack })

    expect(resolved?.kind).toBe('feedback_current_track')
    expect(resolved?.feedbackAction).toBe('not_right')
    expect(resolved?.wantsMusic).toBe(false)
  })

  it('overrides an over-eager llm playback flag for pure current-track dislike', () => {
    const currentTrack = {
      id: 'current',
      title: '沉溺',
      artist: '陈默之',
    } as Track
    const text = '这首歌不好听'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":true,"confidence":0.94,"targetCount":1,"feedbackAction":"not_right","evidence":["这首","不好听"]}',
      text,
      { currentTrack },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack })

    expect(resolved?.kind).toBe('feedback_current_track')
    expect(resolved?.wantsMusic).toBe(false)
  })

  it('keeps directed current-track dislike as a replacement action', () => {
    const currentTrack = {
      id: 'current',
      title: '沉溺',
      artist: '陈默之',
    } as Track
    const text = '这首不太对，激情一点'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":true,"confidence":0.94,"targetCount":1,"feedbackAction":"not_right","moods":["清醒","热烈"],"energy":"high","tempo":"fast","evidence":["这首","激情"]}',
      text,
      { currentTrack },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack })

    expect(resolved?.kind).toBe('feedback_current_track')
    expect(resolved?.wantsMusic).toBe(true)
    expect(resolved?.recommendationIntent.energy).toBe('high')
  })

  it('uses explicit dislike wording over an llm skip label for memory quality', () => {
    const currentTrack = {
      id: 'current',
      title: '沉溺',
      artist: '陈默之',
    } as Track
    const text = '这首歌不好听，换一首激情一点的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":true,"confidence":0.94,"targetCount":1,"feedbackAction":"skip","moods":["清醒","热烈"],"energy":"high","tempo":"fast","evidence":["这首","不好听","激情"]}',
      text,
      { currentTrack },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack })

    expect(resolved?.kind).toBe('feedback_current_track')
    expect(resolved?.feedbackAction).toBe('not_right')
    expect(resolved?.wantsMusic).toBe(true)
    expect(resolved?.recommendationIntent.energy).toBe('high')
  })

  it('rejects llm-routed music execution when the user only mentions a song conversationally', () => {
    const text = '最近枪火这首歌蛮火的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.96,"seedTitle":"枪火","artistQuery":null,"targetCount":1,"evidence":["枪火"]}',
      text,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
  })

  it('rejects llm-routed music execution for pure emotional companionship text', () => {
    const text = '我有点冷'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.95,"targetCount":1,"moods":["陪伴"],"energy":"low","evidence":["冷"]}',
      text,
      {},
    )

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
  })

  it('keeps pure emotional text away from current-track feedback while music can still be requested explicitly', () => {
    const currentTrack = {
      id: 'current',
      title: '旧歌',
      artist: '旧歌手',
    } as Track

    for (const text of ['我有点烦', '最近有点累', '压力有点大']) {
      const fallback = classifyChatIntent(text, { currentTrack })
      const badFeedbackRoute = chatIntentTestHelpers.parseChatRouteContent(
        '{"kind":"feedback_current_track","wantsMusic":false,"confidence":0.94,"feedbackAction":"not_right"}',
        text,
        { currentTrack },
      )

      expect(fallback.kind).not.toBe('feedback_current_track')
      expect(fallback.wantsMusic).toBe(false)
      expect(chatIntentTestHelpers.resolveInferredChatRoute(text, badFeedbackRoute, { currentTrack })).toBeNull()
    }

    const musicText = '我有点烦，推荐点安静的'
    const musicFallback = classifyChatIntent(musicText, { currentTrack })
    const badFeedbackRoute = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":true,"confidence":0.94,"feedbackAction":"not_right","moods":["治愈"],"energy":"low","tempo":"slow"}',
      musicText,
      { currentTrack },
    )

    expect(musicFallback).toMatchObject({
      kind: 'mood_request',
      wantsMusic: true,
    })
    expect(hasMusicActionIntent(musicFallback)).toBe(true)
    expect(chatIntentTestHelpers.resolveInferredChatRoute(musicText, badFeedbackRoute, { currentTrack })).toBeNull()
  })

  it('accepts llm-routed generic discovery when the user asks for something to hear', () => {
    const text = '这个时候有什么值得听的吗'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.92,"targetCount":1,"moods":["陪伴"],"familiarity":"balanced","evidence":["值得听"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(routed?.kind).toBe('mood_request')
    expect(routed?.wantsMusic).toBe(true)
  })

  it('accepts llm-routed artist fit requests without hard play verbs', () => {
    const text = '陈默之的歌适合现在时间点吗'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"artist_request","wantsMusic":true,"confidence":0.94,"artistQuery":"陈默之","seedTitle":null,"targetCount":1,"moods":["陪伴"],"evidence":["陈默之","歌","适合现在"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(routed?.kind).toBe('artist_request')
    expect(routed?.artistQuery).toBe('陈默之')
    expect(routed?.wantsMusic).toBe(true)
  })

  it('rejects casual llm routes for artist fit questions that should execute music', () => {
    const text = '陈默之有哪些歌适合现在时间点的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"casual_chat","wantsMusic":false,"confidence":0.92,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":["陈默之","适合现在"]}',
      text,
      {},
    )
    const fallback = classifyChatIntent(text)

    expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
    expect(fallback.wantsMusic).toBe(true)
    expect(fallback.kind === 'artist_request' || fallback.kind === 'mood_request').toBe(true)
  })

  it('accepts llm-routed artist fit requests when Chinese omits the word song', () => {
    const text = '陈默之有没有适合现在的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"artist_request","wantsMusic":true,"confidence":0.9,"artistQuery":"陈默之","seedTitle":null,"targetCount":1,"moods":["陪伴"],"evidence":["陈默之","适合现在"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(routed?.kind).toBe('artist_request')
    expect(routed?.artistQuery).toBe('陈默之')
    expect(routed?.wantsMusic).toBe(true)
  })

  it('accepts llm-routed artist fit requests with natural what-is-suitable wording', () => {
    for (const text of ['陈默之有什么适合现在的', '陈默之哪些适合这个时间点', '陈默之来点适合这会儿的']) {
      const route = chatIntentTestHelpers.parseChatRouteContent(
        '{"kind":"artist_request","wantsMusic":true,"confidence":0.9,"artistQuery":"陈默之","seedTitle":null,"targetCount":1,"moods":["陪伴"],"evidence":["陈默之","适合"]}',
        text,
        {},
      )
      const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

      expect(routed?.kind).toBe('artist_request')
      expect(routed?.artistQuery).toBe('陈默之')
      expect(routed?.wantsMusic).toBe(true)
    }
  })

  it('accepts llm-routed artist requests with natural share wording', () => {
    for (const text of ['给我分享几首陈默之', '陈默之有什么可以分享的', '分享点陈默之吧']) {
      const route = chatIntentTestHelpers.parseChatRouteContent(
        '{"kind":"artist_request","wantsMusic":true,"confidence":0.9,"artistQuery":"陈默之","seedTitle":null,"targetCount":3,"evidence":["分享","陈默之"]}',
        text,
        {},
      )
      const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

      expect(routed?.kind).toBe('artist_request')
      expect(routed?.artistQuery).toBe('陈默之')
      expect(routed?.wantsMusic).toBe(true)
    }
  })

  it('accepts llm-routed scene requests when Chinese omits the word song', () => {
    const text = '找点适合工作时的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"scene_request","wantsMusic":true,"confidence":0.92,"artistQuery":null,"seedTitle":null,"targetCount":1,"scenes":["下午工作"],"energy":"medium","tempo":"medium","evidence":["找点","工作"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(routed?.kind).toBe('scene_request')
    expect(routed?.wantsMusic).toBe(true)
    expect(routed?.recommendationIntent.scenes).toContain('下午工作')
  })

  it('rejects llm-routed music execution when the request domain is explicitly non-music', () => {
    for (const text of ['推荐一本适合工作的书', '分享几本陈默之写的书']) {
      const route = chatIntentTestHelpers.parseChatRouteContent(
        '{"kind":"scene_request","wantsMusic":true,"confidence":0.95,"artistQuery":null,"seedTitle":null,"targetCount":1,"scenes":["下午工作"],"evidence":["推荐","工作"]}',
        text,
        {},
      )

      expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
    }
  })

  it('rejects llm-routed music actions when the request domain is poetry', () => {
    for (const text of ['推荐一首诗', '分享几首古诗']) {
      const route = chatIntentTestHelpers.parseChatRouteContent(
        '{"kind":"mood_request","wantsMusic":true,"confidence":0.95,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":["推荐","一首"]}',
        text,
        {},
      )

      expect(chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})).toBeNull()
    }
  })

  it('keeps rule entity recovery when the llm router omits an explicit similarity anchor', () => {
    const text = '类似大鱼海棠这首歌的歌曲推荐下'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"similar_to_track","wantsMusic":true,"confidence":0.94,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":["类似","歌曲"]}',
      text,
      { currentTrack: { id: 'current', title: '旧歌', artist: '旧歌手' } as Track },
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {
      currentTrack: { id: 'current', title: '旧歌', artist: '旧歌手' } as Track,
    })
    const recovered = musicSearchTestHelpers.resolutionWithIntentOverride(
      resolveMusicEntitiesFromText(text),
      routed?.llmIntentOverride,
      true,
    )

    expect(routed?.kind).toBe('similar_to_track')
    expect(routed?.llmIntentOverride?.clearSeedTitle).toBeUndefined()
    expect(recovered.seedTitle).toBe('大鱼海棠')
  })

  it('keeps rule artist recovery when the llm router omits an explicit artist request', () => {
    const text = '推荐几首陈默之歌曲'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.94,"artistQuery":null,"seedTitle":null,"targetCount":3,"evidence":["推荐","几首","歌曲"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})
    const recovered = musicSearchTestHelpers.resolutionWithIntentOverride(
      resolveMusicEntitiesFromText(text),
      routed?.llmIntentOverride,
      true,
    )

    expect(routed?.wantsMusic).toBe(true)
    expect(routed?.llmIntentOverride?.clearArtistQuery).toBeUndefined()
    expect(recovered.artistQuery).toBe('陈默之')
  })

  it('keeps rule artist recovery when the llm router extracts the wrong artist', () => {
    const text = '我要听的是Nicky Youre的Part Time Lover'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.94,"artistQuery":"Dabin","seedTitle":"Part Time Lover","targetCount":1,"evidence":["Nicky Youre","Part Time Lover"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})
    const recovered = musicSearchTestHelpers.resolutionWithIntentOverride(
      resolveMusicEntitiesFromText(text),
      routed?.llmIntentOverride,
      true,
    )

    expect(routed?.kind).toBe('direct_song')
    expect(routed?.llmIntentOverride?.artistQuery).toBeUndefined()
    expect(routed?.llmIntentOverride?.clearArtistQuery).toBeUndefined()
    expect(recovered.artistQuery).toBe('Nicky Youre')
    expect(recovered.seedTitle).toBe('Part Time Lover')
  })

  it('still clears generic song words when the router extracts them as a title', () => {
    const text = '你随便来一首陈奕迅的歌曲吧'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.94,"artistQuery":"陈奕迅","seedTitle":"歌曲吧","targetCount":1,"evidence":["陈奕迅","歌曲吧"]}',
      text,
      {},
    )
    const routed = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})
    const recovered = musicSearchTestHelpers.resolutionWithIntentOverride(
      resolveMusicEntitiesFromText(text),
      routed?.llmIntentOverride,
      true,
    )

    expect(routed?.kind).toBe('artist_request')
    expect(routed?.llmIntentOverride?.clearSeedTitle).toBe(true)
    expect(recovered.artistQuery).toBe('陈奕迅')
    expect(recovered.seedTitle).toBeUndefined()
  })

  it('keeps fit requests as music requests when the router falls back to rules', () => {
    const intent = classifyChatIntent('陈默之的歌适合现在时间点吗')

    expect(intent.wantsMusic).toBe(true)
    expect(intent.kind === 'artist_request' || intent.kind === 'mood_request').toBe(true)
  })

  it('removes contradictory recommendation floors from the router output', () => {
    const text = '推荐一首安静但有点力量的歌'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.94,"targetCount":1,"rejectIf":{"minEnergy":0.8,"maxEnergy":0.2,"forbidTempo":["fast","slow"],"requireTempo":["slow"]}}',
      text,
      {},
    )

    expect(route?.override?.rejectIf?.minEnergy).toBeUndefined()
    expect(route?.override?.rejectIf?.maxEnergy).toBeUndefined()
    expect(route?.override?.rejectIf?.forbidTempo).toEqual(['fast'])
    expect(route?.override?.rejectIf?.requireTempo).toEqual(['slow'])
  })

  it('skips implicit playback completion feedback after an explicit rejection', () => {
    expect(trackFeedbackTestHelpers.explicitFeedbackNextOptions).toEqual({
      recordCurrentFeedback: false,
      skippedReason: 'explicit_feedback',
    })
  })

  it('keeps explicit rejection as the only feedback when queue fallback changes the track', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const next: Track = { id: 'next', title: '新歌', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/next.mp3' }
    const intent = classifyChatIntent('这首不好听，换一首', { currentTrack: current })
    const recordFeedback = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const playNext = vi.fn(async () => ({
      current: next,
      position: 0,
      duration: 0,
      status: 'loading' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首不好听，换一首', undefined, {
      recordFeedback,
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement: vi.fn(async () => null),
      playNext,
    })

    expect(recordFeedback).toHaveBeenCalledOnce()
    expect(recordFeedback).toHaveBeenCalledWith(current, 'not_right', '这首不好听，换一首')
    expect(playNext).toHaveBeenCalledWith({ recordCurrentFeedback: false, skippedReason: 'explicit_feedback' })
    expect(result).toMatchObject({
      handled: true,
      tracks: [next],
      hints: { playbackAlreadyApplied: true },
    })
  })

  it('records plain next-track requests as lightweight skips instead of explicit misses', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const next: Track = { id: 'next', title: '新歌', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/next.mp3' }
    const intent = classifyChatIntent('下一首', { currentTrack: current })
    const recordFeedback = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const recordSkippedFeedback = vi.fn(async () => ({ ok: true, message: 'skip' }))
    const rememberMusicCorrection = vi.fn(() => undefined)
    const playNext = vi.fn(async () => ({
      current: next,
      position: 0,
      duration: 0,
      status: 'loading' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '下一首', undefined, {
      recordFeedback,
      recordSkippedFeedback,
      ensureFavorite: vi.fn(),
      rememberMusicCorrection,
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement: vi.fn(async () => null),
      playNext,
    })

    expect(recordFeedback).not.toHaveBeenCalled()
    expect(recordSkippedFeedback).toHaveBeenCalledWith(current, '下一首')
    expect(rememberMusicCorrection).not.toHaveBeenCalled()
    expect(playNext).toHaveBeenCalledWith({ recordCurrentFeedback: false, skippedReason: 'explicit_feedback' })
    expect(result).toMatchObject({
      handled: true,
      tracks: [next],
      hints: { playbackAlreadyApplied: true },
    })
    expect(result.handled && result.content).toContain('好，现在换成')
  })

  it('uses directed replacement for neutral change requests without writing negative memory', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const fresh: Track = { id: 'fresh', title: '新方向', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/fresh.mp3' }
    const intent = classifyChatIntent('换一首激情一点的', { currentTrack: current })
    const recordFeedback = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const recordSkippedFeedback = vi.fn(async () => ({ ok: true, message: 'skip' }))
    const rememberMusicCorrection = vi.fn(() => undefined)
    const searchDirectedReplacement = vi.fn(async () => fresh)

    const result = await handleCurrentTrackFeedback(intent, current, '换一首激情一点的', undefined, {
      recordFeedback,
      recordSkippedFeedback,
      ensureFavorite: vi.fn(),
      rememberMusicCorrection,
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement,
      searchGenericReplacement: vi.fn(async () => null),
      playNext: vi.fn(),
    })

    expect(recordFeedback).not.toHaveBeenCalled()
    expect(recordSkippedFeedback).toHaveBeenCalledWith(current, '换一首激情一点的')
    expect(rememberMusicCorrection).not.toHaveBeenCalled()
    expect(searchDirectedReplacement).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      handled: true,
      tracks: [fresh],
    })
    expect(result.handled && result.content).toContain('好，换一首更贴近你刚说的')
  })

  it('keeps overclassified directional nudges out of explicit miss memory', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const fresh: Track = { id: 'fresh', title: '更高昂', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/fresh.mp3' }
    const intent = {
      ...classifyChatIntent('这首再激情一点', { currentTrack: current }),
      kind: 'feedback_current_track' as const,
      feedbackAction: 'not_right' as const,
      wantsMusic: true,
    }
    const recordFeedback = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const recordSkippedFeedback = vi.fn(async () => ({ ok: true, message: 'skip' }))
    const rememberMusicCorrection = vi.fn(() => undefined)

    const result = await handleCurrentTrackFeedback(intent, current, '这首再激情一点', undefined, {
      recordFeedback,
      recordSkippedFeedback,
      ensureFavorite: vi.fn(),
      rememberMusicCorrection,
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => fresh),
      searchGenericReplacement: vi.fn(async () => null),
      playNext: vi.fn(),
    })

    expect(trackFeedbackTestHelpers.shouldRecordExplicitMiss('这首再激情一点')).toBe(false)
    expect(recordFeedback).not.toHaveBeenCalled()
    expect(recordSkippedFeedback).toHaveBeenCalledWith(current, '这首再激情一点')
    expect(rememberMusicCorrection).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      handled: true,
      tracks: [fresh],
    })
  })

  it('treats overly high-energy current-track feedback as an explicit miss before replacing it', async () => {
    const current: Track = { id: 'current', title: '太亮的歌', artist: '旧歌手', source: 'netease' }
    const fresh: Track = { id: 'fresh', title: '安静一点', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/fresh.mp3' }
    const text = '这首太情绪高昂了，换一首安静点'
    const intent = classifyChatIntent(text, { currentTrack: current })
    const recordFeedback = vi.fn(async () => ({ ok: true, message: 'ok' }))
    const recordSkippedFeedback = vi.fn(async () => ({ ok: true, message: 'skip' }))

    const result = await handleCurrentTrackFeedback(intent, current, text, undefined, {
      recordFeedback,
      recordSkippedFeedback,
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => fresh),
      searchGenericReplacement: vi.fn(async () => null),
      playNext: vi.fn(),
    })

    expect(intent).toMatchObject({
      kind: 'feedback_current_track',
      feedbackAction: 'not_right',
      wantsMusic: true,
    })
    expect(trackFeedbackTestHelpers.shouldRecordExplicitMiss(text)).toBe(true)
    expect(recordFeedback).toHaveBeenCalledWith(current, 'not_right', text)
    expect(recordSkippedFeedback).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      handled: true,
      tracks: [fresh],
    })
  })

  it('keeps positive high-energy requests out of current-track rejection', () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const intent = classifyChatIntent('来首情绪高昂一点的歌', { currentTrack: current })

    expect(intent.kind).not.toBe('feedback_current_track')
    expect(intent.wantsMusic).toBe(true)
  })

  it('uses directed search before queue fallback when rejection includes a direction', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const fresh: Track = { id: 'fresh', title: '新方向', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/fresh.mp3' }
    const intent = classifyChatIntent('这首歌不好听，换一首激情一点的', { currentTrack: current })
    const searchDirectedReplacement = vi.fn(async () => fresh)
    const searchGenericReplacement = vi.fn(async () => null)
    const playNext = vi.fn(async () => ({
      current: null,
      position: 0,
      duration: 0,
      status: 'idle' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首歌不好听，换一首激情一点的', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement,
      searchGenericReplacement,
      playNext,
    })

    expect(searchDirectedReplacement).toHaveBeenCalledOnce()
    expect(searchGenericReplacement).not.toHaveBeenCalled()
    expect(playNext).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      handled: true,
      tracks: [fresh],
    })
  })

  it('rejects a directed replacement result that is the same song under a different id', async () => {
    const current: Track = { id: 'current-a', title: '冷夜', artist: '陈奕迅', source: 'netease' }
    const sameSongDifferentId: Track = { id: 'current-b', title: '冷夜', artist: '陈奕迅', source: 'netease', playUrl: 'https://example.com/same.mp3' }
    const generic: Track = { id: 'generic', title: '更有劲', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/generic.mp3' }
    const intent = classifyChatIntent('这首不好听，换一首激情一点的', { currentTrack: current })
    const searchGenericReplacement = vi.fn(async () => generic)
    const playNext = vi.fn(async () => ({
      current: null,
      position: 0,
      duration: 0,
      status: 'idle' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首不好听，换一首激情一点的', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => sameSongDifferentId),
      searchGenericReplacement,
      playNext,
    })

    expect(searchGenericReplacement).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      handled: true,
      tracks: [generic],
    })
    expect(result.handled && result.content).toContain('换成新歌手的《更有劲》')
  })

  it('records pure dislike without searching or skipping playback', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const intent = classifyChatIntent('这首歌不好听', { currentTrack: current })
    const searchGenericReplacement = vi.fn(async () => null)
    const playNext = vi.fn(async () => ({
      current: null,
      position: 0,
      duration: 0,
      status: 'idle' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首歌不好听', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement,
      playNext,
    })

    expect(searchGenericReplacement).not.toHaveBeenCalled()
    expect(playNext).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      handled: true,
      tracks: [],
    })
  })

  it('uses llm music intent plus replacement direction as a fresh track change request', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const fresh: Track = { id: 'fresh', title: '更高昂', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/fresh.mp3' }
    const intent = {
      ...classifyChatIntent('这首不太对，激情一点', { currentTrack: current }),
      wantsMusic: true,
    }
    const searchDirectedReplacement = vi.fn(async () => fresh)
    const searchGenericReplacement = vi.fn(async () => null)
    const playNext = vi.fn(async () => ({
      current: null,
      position: 0,
      duration: 0,
      status: 'idle' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首不太对，激情一点', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement,
      searchGenericReplacement,
      playNext,
    })

    expect(searchDirectedReplacement).toHaveBeenCalledOnce()
    expect(searchGenericReplacement).not.toHaveBeenCalled()
    expect(playNext).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      handled: true,
      tracks: [fresh],
    })
  })

  it('uses rule fallback replacement direction as a fresh track change request', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const fresh: Track = { id: 'fresh', title: '更有劲', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/fresh.mp3' }
    const intent = classifyChatIntent('这首不太对，激情一点', { currentTrack: current })
    const searchDirectedReplacement = vi.fn(async () => fresh)
    const searchGenericReplacement = vi.fn(async () => null)
    const playNext = vi.fn(async () => ({
      current: null,
      position: 0,
      duration: 0,
      status: 'idle' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首不太对，激情一点', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement,
      searchGenericReplacement,
      playNext,
    })

    expect(searchDirectedReplacement).toHaveBeenCalledOnce()
    expect(searchGenericReplacement).not.toHaveBeenCalled()
    expect(playNext).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      handled: true,
      tracks: [fresh],
    })
  })

  it('does not report a successful change when playback next returns the rejected current track', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const generic: Track = { id: 'generic', title: '换个方向', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/generic.mp3' }
    const intent = classifyChatIntent('这首不好听，换一首', { currentTrack: current })
    const playNext = vi.fn(async () => ({
      current,
      position: 0,
      duration: 0,
      status: 'playing' as const,
      volume: 100,
      queue: [current],
      history: [current],
    }))
    const searchGenericReplacement = vi.fn(async () => generic)

    const result = await handleCurrentTrackFeedback(intent, current, '这首不好听，换一首', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement,
      playNext,
    })

    expect(playNext).toHaveBeenCalledOnce()
    expect(searchGenericReplacement).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      handled: true,
      tracks: [generic],
    })
    expect(result.handled && result.content).toContain('换成新歌手的《换个方向》')
  })

  it('does not report a successful change when playback next returns the same song under a different id', async () => {
    const current: Track = { id: 'current-a', title: '冷夜', artist: '陈奕迅', source: 'netease' }
    const sameSongDifferentId: Track = { id: 'current-b', title: '冷夜', artist: '陈奕迅', source: 'netease' }
    const generic: Track = { id: 'generic', title: '换个方向', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/generic.mp3' }
    const intent = classifyChatIntent('这首不好听，换一首', { currentTrack: current })
    const playNext = vi.fn(async () => ({
      current: sameSongDifferentId,
      position: 0,
      duration: 0,
      status: 'playing' as const,
      volume: 100,
      queue: [sameSongDifferentId],
      history: [current],
    }))
    const searchGenericReplacement = vi.fn(async () => generic)

    const result = await handleCurrentTrackFeedback(intent, current, '这首不好听，换一首', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => undefined),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement: vi.fn(async () => null),
      searchGenericReplacement,
      playNext,
    })

    expect(playNext).toHaveBeenCalledOnce()
    expect(searchGenericReplacement).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      handled: true,
      tracks: [generic],
    })
    expect(result.handled && result.content).toContain('换成新歌手的《换个方向》')
  })

  it('does not let track-only correction memory block a directed replacement search', async () => {
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease' }
    const directed: Track = { id: 'directed', title: '更有劲', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/directed.mp3' }
    const intent = classifyChatIntent('这首不对，换一首激情一点的', { currentTrack: current })
    const searchDirectedReplacement = vi.fn(async () => directed)
    const searchGenericReplacement = vi.fn(async () => null)
    const playNext = vi.fn(async () => ({
      current: null,
      position: 0,
      duration: 0,
      status: 'idle' as const,
      volume: 100,
      queue: [],
      history: [current],
    }))

    const result = await handleCurrentTrackFeedback(intent, current, '这首不对，换一首激情一点的', undefined, {
      recordFeedback: vi.fn(async () => ({ ok: true, message: 'ok' })),
      ensureFavorite: vi.fn(),
      rememberMusicCorrection: vi.fn(() => ({ excludedTrackKeys: ['id:current'] })),
      searchCorrectedReplacement: vi.fn(async () => null),
      searchDirectedReplacement,
      searchGenericReplacement,
      playNext,
    })

    expect(searchDirectedReplacement).toHaveBeenCalledOnce()
    expect(searchGenericReplacement).not.toHaveBeenCalled()
    expect(playNext).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      handled: true,
      tracks: [directed],
    })
  })

  it('keeps pending cancellation on the deterministic state path', () => {
    expect(chatSendPipelineTestHelpers.shouldForcePendingIntentCancel('算了，先不找了', true)).toBe(true)
    expect(chatSendPipelineTestHelpers.shouldForcePendingIntentCancel('算了，先不找了', false)).toBe(false)
    expect(chatSendPipelineTestHelpers.shouldForcePendingIntentCancel('算了，给我来首周深', true)).toBe(false)
  })

  it('lets fresh llm routes override stale pending fallback state', () => {
    expect(chatSendPipelineTestHelpers.shouldUsePendingIntentFallback({
      hasPendingIntent: true,
      routeSource: 'llm',
      forcePendingCancel: false,
    })).toBe(false)
    expect(chatSendPipelineTestHelpers.shouldUsePendingIntentFallback({
      hasPendingIntent: false,
      routeSource: 'llm',
      forcePendingCancel: false,
    })).toBe(false)
    expect(chatSendPipelineTestHelpers.shouldUsePendingIntentFallback({
      hasPendingIntent: true,
      routeSource: 'rules',
      forcePendingCancel: false,
    })).toBe(true)
    expect(chatSendPipelineTestHelpers.shouldUsePendingIntentFallback({
      hasPendingIntent: true,
      routeSource: 'llm',
      forcePendingCancel: true,
    })).toBe(true)
  })

  it('resolves a short artist reply against a pending missing-artist song', () => {
    setPendingMusicEntityClarification({
      seedTitle: '大鱼海棠',
      ambiguity: 'missing_artist',
    }, '类似大鱼海棠这首歌的歌曲推荐下')

    try {
      expect(resolvePendingMusicEntityReply('周深')?.query).toBe('我要听周深的《大鱼海棠》')
    } finally {
      clearPendingDirectSongState()
    }
  })

  it('keeps confirmation words out of pending artist extraction', () => {
    setPendingMusicEntityClarification({
      seedTitle: '主角',
      ambiguity: 'missing_artist',
    }, '我要听《主角》')

    try {
      const confirmation = resolvePendingMusicEntityReply('对')
      expect(confirmation?.query).toBeUndefined()
      expect(confirmation?.response).toContain('歌手名')
      expect(resolvePendingMusicEntityReply('王菲')?.query).toBe('我要听王菲的《主角》')
    } finally {
      clearPendingDirectSongState()
    }
  })

  it('validates pending continuation targets against live context', () => {
    const content = '{"kind":"pending_reply","wantsMusic":true,"confidence":0.95,"continuationTarget":"direct_song","targetCount":1}'
    expect(chatIntentTestHelpers.parseChatRouteContent(content, '周深', {})).toBeNull()
    expect(chatIntentTestHelpers.parseChatRouteContent(content, '周深', {
      pendingIntent: {
        target: 'direct_song',
        sourceText: '我要听《大鱼》',
        seedTitle: '大鱼',
      },
    })?.continuationTarget).toBe('direct_song')
  })

  it('requires an explicit taste action for a pending taste reply', () => {
    const context = {
      pendingTasteQuestion: {
        content: '这首打中你的是旋律还是人声？',
        kind: 'recommendation_followup',
      },
    }
    expect(chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"pending_reply","wantsMusic":false,"confidence":0.95,"continuationTarget":"taste_question"}',
      '旋律更打动我',
      context,
    )).toBeNull()
    expect(chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"pending_reply","wantsMusic":false,"confidence":0.95,"continuationTarget":"taste_question","pendingTasteAction":"answer_only"}',
      '旋律更打动我',
      context,
    )?.pendingTasteAction).toBe('answer_only')
  })

  it('lets llm route inherit the previous artist when user asks Echo to pick one', () => {
    const context = {
      recentDialog: [
        { role: 'user' as const, content: '陈默之有哪些歌适合现在时间点的' },
        { role: 'assistant' as const, content: '你想先试哪一首，还是我来找一首开始放？' },
      ],
    }
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"artist_request","wantsMusic":true,"confidence":0.96,"artistQuery":"陈默之","seedTitle":null,"targetCount":1,"evidence":["承接上一轮","挑一首"]}',
      '你帮我挑一首',
      context,
    )

    const intent = chatIntentTestHelpers.resolveInferredChatRoute('你帮我挑一首', route, context)

    expect(intent).toMatchObject({
      kind: 'artist_request',
      wantsMusic: true,
      artistQuery: '陈默之',
    })
    expect(hasMusicActionIntent(intent!)).toBe(true)
  })

  it('recovers the previous artist when llm only recognizes a contextual music action', () => {
    const context = {
      recentDialog: [
        { role: 'user' as const, content: '陈默之有哪些歌适合现在时间点的' },
        { role: 'assistant' as const, content: '你想先试哪一首，还是我来找一首开始放？' },
      ],
    }
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.9,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":["挑一首"]}',
      '你帮我挑一首',
      context,
    )

    const intent = chatIntentTestHelpers.resolveInferredChatRoute('你帮我挑一首', route, context)

    expect(intent).toMatchObject({
      kind: 'artist_request',
      wantsMusic: true,
      artistQuery: '陈默之',
      routeSource: 'llm',
    })
    expect(hasMusicActionIntent(intent!)).toBe(true)
  })

  it('lets rule fallback inherit the previous artist when LLM routing is unavailable', () => {
    const intent = chatIntentTestHelpers.applyRecentMusicContext(
      classifyChatIntent('你帮我挑一首'),
      {
        recentDialog: [
          { role: 'user', content: '陈默之有哪些歌适合现在时间点的' },
          { role: 'assistant', content: '你想先试哪一首，还是我来找一首开始放？' },
        ],
      },
    )

    expect(intent).toMatchObject({
      kind: 'artist_request',
      wantsMusic: true,
      artistQuery: '陈默之',
    })
    expect(hasMusicActionIntent(intent)).toBe(true)
  })

  it('carries recommendation constraints through the unified route', () => {
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.96,"targetCount":1,"moods":["清醒","热烈"],"energy":"high","tempo":"fast","rejectIf":{"minEnergy":0.55,"forbidTempo":["slow"],"requireTempo":["fast"]},"evidence":["激情"]}',
      '换一首激情一点的',
      {},
    )
    expect(route?.override?.energy).toBe('high')
    expect(route?.override?.tempo).toBe('fast')
    expect(route?.override?.rejectIf?.minEnergy).toBe(0.55)
    expect(route?.override?.rejectIf?.forbidTempo).toContain('slow')
  })

  it('treats bare change wording as current-track feedback when a track is playing', () => {
    const current = { id: 'current', title: '旧歌', artist: '旧歌手' } as Track
    const fallback = classifyChatIntent('换一首激情一点的', { currentTrack: current })
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":true,"confidence":0.94,"targetCount":1,"feedbackAction":"skip","moods":["清醒","热烈"],"energy":"high","tempo":"fast","evidence":["换一首","激情"]}',
      '换一首激情一点的',
      { currentTrack: current },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute('换一首激情一点的', route, { currentTrack: current })

    expect(fallback).toMatchObject({
      kind: 'feedback_current_track',
      feedbackAction: 'skip',
      wantsMusic: true,
    })
    expect(resolved).toMatchObject({
      kind: 'feedback_current_track',
      feedbackAction: 'skip',
      wantsMusic: true,
      routeSource: 'llm',
    })
  })

  it('keeps replacement semantics executable when playback state is unavailable', () => {
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"feedback_current_track","wantsMusic":true,"confidence":0.94,"targetCount":1,"feedbackAction":"skip","moods":["清醒","热烈"],"energy":"high","tempo":"fast","evidence":["换一首","激情"]}',
      '换一首激情一点的',
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute('换一首激情一点的', route, {})

    expect(resolved).toMatchObject({
      kind: 'mood_request',
      wantsMusic: true,
      routeSource: 'llm',
    })
    expect(resolved?.recommendationIntent.energy).toBe('high')
    expect(resolved?.recommendationIntent.tempo).toBe('fast')
    expect(resolved?.feedbackAction).toBeUndefined()
    expect(hasMusicActionIntent(resolved!)).toBe(true)
  })

  it('keeps explicit similarity anchors out of current-track feedback', () => {
    const current = { id: 'current', title: '旧歌', artist: '旧歌手' } as Track
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"similar_to_track","wantsMusic":true,"confidence":0.96,"seedTitle":"大鱼海棠","targetCount":1,"evidence":["类似","大鱼海棠"]}',
      '类似大鱼海棠这首歌的歌曲推荐下',
      { currentTrack: current },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute('类似大鱼海棠这首歌的歌曲推荐下', route, { currentTrack: current })

    expect(resolved).toMatchObject({
      kind: 'similar_to_track',
      seedTitle: '大鱼海棠',
      wantsMusic: true,
    })
  })

  it('routes natural described-title listening wording through the LLM intent path', () => {
    const text = '最近枪火这首歌蛮火的，听听看'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.96,"seedTitle":"枪火","artistQuery":null,"targetCount":1,"evidence":["枪火","这首歌","听听看"]}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(resolved).toMatchObject({
      kind: 'direct_song',
      seedTitle: '枪火',
      wantsMusic: true,
      routeSource: 'llm',
    })
    expect(hasMusicActionIntent(resolved!)).toBe(true)
  })

  it('keeps described-title listening wording away from current-track feedback when another song is playing', () => {
    const current: Track = {
      id: 'current',
      title: 'Sonata No. 8 in C Minor, Op. 13, "Pathetique": II. Adagio cantabile',
      artist: 'Arthur Rubinstein',
      source: 'netease',
    }
    const text = '最近枪火这首歌蛮火的，听听看'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"direct_song","wantsMusic":true,"confidence":0.96,"seedTitle":"枪火","artistQuery":null,"targetCount":1,"evidence":["枪火","这首歌","听听看"]}',
      text,
      { currentTrack: current },
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, { currentTrack: current })

    expect(resolved).toMatchObject({
      kind: 'direct_song',
      seedTitle: '枪火',
      wantsMusic: true,
      routeSource: 'llm',
    })
    expect(resolved?.feedbackAction).toBeUndefined()
    expect(hasMusicActionIntent(resolved!)).toBe(true)
  })

  it('keeps natural described-title listening executable when LLM routing is unavailable', () => {
    const intent = classifyChatIntent('最近枪火这首歌蛮火的，听听看')

    expect(intent).toMatchObject({
      kind: 'direct_song',
      seedTitle: '枪火',
      wantsMusic: true,
    })
    expect(hasMusicActionIntent(intent)).toBe(true)
  })

  it('keeps fit-style contextual music questions executable without explicit song words', () => {
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.93,"targetCount":1,"moods":["陪伴"],"familiarity":"balanced","evidence":["这个时候","值得听"]}',
      '这个时候有什么值得听的吗',
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute('这个时候有什么值得听的吗', route, {})
    const fallback = classifyChatIntent('这个时候有什么值得听的吗')

    expect(resolved).toMatchObject({
      kind: 'mood_request',
      wantsMusic: true,
      routeSource: 'llm',
    })
    expect(hasMusicActionIntent(resolved!)).toBe(true)
    expect(fallback.wantsMusic).toBe(true)
    expect(hasMusicActionIntent(fallback)).toBe(true)
  })

  it('keeps colloquial good-listening requests executable through LLM safety arbitration', () => {
    const text = '有什么好听的吗'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.91,"targetCount":1,"familiarity":"balanced","evidence":["好听"]}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(resolved).toMatchObject({
      kind: 'mood_request',
      wantsMusic: true,
      routeSource: 'llm',
    })
    expect(hasMusicActionIntent(resolved!)).toBe(true)
  })

  it('keeps colloquial arrange wording executable through LLM safety arbitration', () => {
    const text = '给我整点好听的'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"mood_request","wantsMusic":true,"confidence":0.91,"targetCount":1,"familiarity":"balanced","evidence":["整点","好听"]}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(resolved).toMatchObject({
      kind: 'mood_request',
      wantsMusic: true,
      routeSource: 'llm',
    })
    expect(hasMusicActionIntent(resolved!)).toBe(true)
  })

  it('keeps colloquial artist arrange wording executable through LLM safety arbitration', () => {
    const text = '给我安排一首陈奕迅'
    const route = chatIntentTestHelpers.parseChatRouteContent(
      '{"kind":"artist_request","wantsMusic":true,"confidence":0.93,"artistQuery":"陈奕迅","seedTitle":null,"targetCount":1,"evidence":["安排一首","陈奕迅"]}',
      text,
      {},
    )
    const resolved = chatIntentTestHelpers.resolveInferredChatRoute(text, route, {})

    expect(resolved).toMatchObject({
      kind: 'artist_request',
      artistQuery: '陈奕迅',
      wantsMusic: true,
      routeSource: 'llm',
    })
    expect(hasMusicActionIntent(resolved!)).toBe(true)
  })

  it('keeps colloquial good-listening requests executable when LLM routing is unavailable', () => {
    for (const text of ['有什么好听的吗', '推荐点好听的', '来点顺耳的吧', '给我整点好听的']) {
      const intent = classifyChatIntent(text)

      expect(intent).toMatchObject({
        kind: 'mood_request',
        wantsMusic: true,
      })
      expect(hasMusicActionIntent(intent)).toBe(true)
    }
  })

  it('keeps warm emotional music requests executable and records the short-term state', () => {
    const text = '我有点冷，来点暖一点的'
    const intent = classifyChatIntent(text)
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal(text, intent)

    expect(intent).toMatchObject({
      kind: 'mood_request',
      wantsMusic: true,
    })
    expect(intent.recommendationIntent).toMatchObject({
      energy: 'low',
      tempo: 'slow',
    })
    expect(intent.recommendationIntent.moods).toContain('治愈')
    expect(hasMusicActionIntent(intent)).toBe(true)
    expect(signal).toMatchObject({
      kind: 'event_started',
      payload: expect.objectContaining({ target: '觉得有点冷' }),
    })
  })

  it('keeps non-music colloquial arrange wording out of fallback music routing', () => {
    for (const text of ['给我整点吃的', '安排点工作', '弄点咖啡']) {
      const intent = classifyChatIntent(text)

      expect(intent.wantsMusic).toBe(false)
      expect(hasMusicActionIntent(intent)).toBe(false)
    }
  })

  it('keeps colloquial artist arrange wording executable when LLM routing is unavailable', () => {
    for (const text of ['给我安排一首陈奕迅', '整一首周杰伦', '搞一首王菲吧']) {
      const intent = classifyChatIntent(text)

      expect(intent).toMatchObject({
        kind: 'artist_request',
        wantsMusic: true,
      })
      expect(intent.artistQuery).toBeTruthy()
      expect(hasMusicActionIntent(intent)).toBe(true)
    }
  })
})
