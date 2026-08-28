import type { ChatIntentContext, ChatIntentKind } from './chat'

/**
 * 意图路由评测集——Echo 理解能力的复利资产。
 *
 * 规约：
 * 1. 每次真实线上失败（错误道歉 / 放错歌 / 不懂装懂），在修复它的同一个提交里
 *    把原话加进本文件，标注 source: 'real-failure' 和日期。此后同类失败永不重犯。
 * 2. 修复行为可能误伤的相邻句式，加 source: 'guard' 用例锁住。
 * 3. 只对确定性路径断言（规则路由 + 实体抽取 + 上下文继承，即 LLM 不可用时的
 *    降级路径）；LLM 路由的评测需要录制夹具，另行扩展，勿在此混入网络依赖。
 * 4. expect.kind 可给多个可接受值（如 direct_song 的追问变体），但 artist/seedTitle
 *    必须精确——实体锚点是理解正确性的核心断言。
 * 5. 新增用例先跑一遍：如果它失败，说明当前行为确实是坏的，修到它通过为止；
 *    不允许为让用例通过而放松断言。
 */

export interface IntentEvalCase {
  id: string
  /** 用户原话（多轮用例里指最后一轮） */
  text: string
  /** 多轮用例：此前的对话与音乐会话状态 */
  context?: ChatIntentContext
  expect: {
    kind: ChatIntentKind | ChatIntentKind[]
    artistQuery?: string | null
    seedTitle?: string | null
    wantsMusic?: boolean
  }
  source: 'real-failure' | 'guard' | 'synthetic'
  note?: string
  addedAt: string
}

export const INTENT_EVAL_CASES: IntentEvalCase[] = [
  {
    id: 'real-2026-08-16-chenmozhi-opinion-ask',
    text: '你觉得陈默之有什么好听的，随便推荐一首给我',
    expect: { kind: 'artist_request', artistQuery: '陈默之', wantsMusic: true },
    source: 'real-failure',
    note: '「随便」命中 SCENE_PATTERN 判成场景请求，从未搜索歌手本人；网易云实有该歌手（id=94751641）。用户两次提问、两次得到「没翻到」。',
    addedAt: '2026-08-16',
  },
  {
    id: 'real-2026-08-16-chenmozhi-followup-inherit',
    text: '再随便来3首热门歌曲',
    context: {
      recentDialog: [
        { role: 'user', content: '推荐一首陈默之的最新歌曲' },
        { role: 'assistant', content: '陈默之的最新，给你挑了一首。' },
      ],
      musicSession: {
        sourceText: '推荐一首陈默之的最新歌曲',
        intentKind: 'artist_request',
        tracks: [{ title: '汽笛', artist: '陈默之' }],
        artistQuery: '陈默之',
      },
    },
    expect: { kind: 'artist_request', artistQuery: '陈默之', wantsMusic: true },
    source: 'real-failure',
    note: '续接轮的「随便」管辖选哪几首，不更换话题主语；「再」+会话状态 → 歌手槽继承。',
    addedAt: '2026-08-16',
  },
  {
    id: 'real-2026-08-16-possessive-artist-tail',
    text: '随便来一首苏星婕的',
    expect: { kind: 'artist_request', artistQuery: '苏星婕', wantsMusic: true },
    source: 'real-failure',
    note: '0.1.16 真机验证时发现：尾「的」（所有格标记）被吞进实体，抽出歌手"苏星婕的"，触发歌手/歌名歧义追问。所有格收尾指向歌手；「放一首晴天」（无「的」）仍走歌名路径。',
    addedAt: '2026-08-16',
  },
  {
    id: 'guard-review-topic-phrase-not-artist',
    text: '来一首关于夏天的',
    expect: { kind: 'mood_request', artistQuery: null, wantsMusic: true },
    source: 'guard',
    note: 'code review 对抗探测（0.1.17 所有格模式）：「关于夏天」是主题不是歌手——所有格模式必须拒绝，落到 mood/泛请求。',
    addedAt: '2026-08-16',
  },
  {
    id: 'guard-review-genre-tail-not-artist',
    text: '找几首轻音乐睡前的',
    expect: { kind: ['mood_request', 'scene_request'], artistQuery: null, wantsMusic: true },
    source: 'guard',
    note: 'code review 对抗探测：「轻音乐睡前」经 normalize 截成单字「轻」——单字名一律不可信（isPlausibleArtistName <2 字拒绝）；睡前判场景是正确行为。',
    addedAt: '2026-08-16',
  },
  {
    id: 'guard-bare-listen-listen',
    text: '随便听听',
    expect: { kind: 'mood_request', artistQuery: null, wantsMusic: true },
    source: 'guard',
    note: '「随便听听」明显想听点什么，曾被判成 casual_chat 不给歌。句尾锚定的听听变体补上；「我想听听你的想法」不受影响（不句尾）。',
    addedAt: '2026-08-16',
  },
  {
    id: 'guard-random-filler-with-artist',
    text: '随便来点周杰伦',
    expect: { kind: 'artist_request', artistQuery: '周杰伦', wantsMusic: true },
    source: 'guard',
    note: '「随便」从 SCENE_PATTERN 移除后的守卫：授权词+裸歌手收尾，歌手必须被锚定。',
    addedAt: '2026-08-16',
  },
  {
    id: 'guard-pure-scene-intact',
    text: '来点睡前音乐',
    expect: { kind: 'scene_request', artistQuery: null, wantsMusic: true },
    source: 'guard',
    note: '真正的场景词（睡前）不受本次修改影响；「睡前」同时被歌手词表排除，不会被误抽成歌手。',
    addedAt: '2026-08-16',
  },
  {
    id: 'guard-direct-song-intact',
    text: '放一首晴天',
    expect: { kind: ['direct_song', 'clarification_needed'], seedTitle: '晴天', wantsMusic: true },
    source: 'guard',
    note: 'artist 优先级调换不得破坏点名歌路径；无歌手时允许追问变体。',
    addedAt: '2026-08-16',
  },
  {
    id: 'guard-abandon-blocks-inherit',
    text: '算了，随便来点别的',
    context: {
      recentDialog: [
        { role: 'user', content: '推荐一首陈默之的最新歌曲' },
        { role: 'assistant', content: '陈默之的最新，给你挑了一首。' },
      ],
      musicSession: {
        sourceText: '推荐一首陈默之的最新歌曲',
        intentKind: 'artist_request',
        tracks: [{ title: '汽笛', artist: '陈默之' }],
        artistQuery: '陈默之',
      },
    },
    expect: { kind: 'mood_request', artistQuery: null, wantsMusic: true },
    source: 'guard',
    note: '「算了/别的」是抛弃信号：清空歌手槽，不做继承。「别的」同时进不可信歌手词表。',
    addedAt: '2026-08-16',
  },
  {
    id: 'real-2026-08-28-venting-phrase-not-artist',
    text: '心里堵得慌，想听点能把这口气散掉的音乐',
    expect: { kind: 'mood_request', artistQuery: null, seedTitle: null, wantsMusic: true },
    source: 'real-failure',
    note: '「听 X 的 Y」配对模式把「点能把这口气散掉」吞成歌手名（artist_request + 假实体），云端必然搜空。使役描述标记（能把/散掉/这口气…）进不可信歌手词表；宣泄向由翻译器看整句决定。',
    addedAt: '2026-08-28',
  },
  {
    id: 'real-2026-08-28-blocked-want-quiet',
    text: '心里堵得慌，想安静一会儿',
    expect: { kind: 'mood_request', artistQuery: null, seedTitle: null, wantsMusic: true },
    source: 'real-failure',
    note: '决策 1 的歧义语境锁定：同一个「堵」字与上一例方向相反（安抚向）。降级路径必须落在 mood_request 且不产假实体，具体搜宣泄还是安抚由翻译器读整句判定。',
    addedAt: '2026-08-28',
  },
  {
    id: 'real-2026-08-28-noun-first-music-request',
    text: '当心情烦躁的时候，你有什么歌曲推荐给我',
    expect: { kind: 'mood_request', artistQuery: null, seedTitle: null, wantsMusic: true },
    source: 'real-failure',
    note: '历史「走神」原话：宾动顺序（歌曲推荐）不被动宾模式的 MUSIC_ACTION 认领，降级路径 wantsMusic=false；LLM 路由即使判对 mood_request 也被安全闸门以「无执行线索」拒绝。补 MUSIC_NOUN_FIRST_REQUEST_PATTERN 同时进降级分类与闸门。',
    addedAt: '2026-08-28',
  },
  {
    id: 'guard-weather-not-music',
    text: '今天天气怎么样',
    expect: { kind: 'weather', artistQuery: null, wantsMusic: false },
    source: 'guard',
    note: 'Phase C 后非音乐输入由确定性兜底直接终审（不再二次调 LLM），天气分支必须保持稳定且不触发放歌。',
    addedAt: '2026-08-28',
  },
]
