import { stableInt } from '../../shared/deterministic'

export const WAITING_LINES = [
  '等我翻翻我的宝藏歌单',
  '让我在旋律里捞一首合适的',
  '我在听，也在找，稍等呀',
  '耳朵已经竖起来了，在找了',
  '音符正在赶来的路上',
  '这次有点难到我了，让我再琢磨下',
  '你的心情有点复杂，我需要多听几秒',
  '这个氛围有点微妙，得仔细挑一首',
  '我在很认真地感受你说的',
  '正在把感觉翻译成旋律',
  '别急，好音乐值得等一小下',
  '想给你一首，贴近现在的歌',
  '在脑内开了一场小型试听会',
  '像翻旧唱片一样，为你找那一轨',
  '嗯，我听到了',
  '正在感受你此刻的心情频率',
  '马上就好，旋律正在加载',
  '在翻了在翻了，歌单有点长',
  '等等，我正从耳机里往外掏歌',
  '脑内点歌台，正在为你连线',
  '挑歌中，请允许我纠结几秒',
  '马上，等我抓个旋律塞给你',
  '稍等，我在心里过一遍前奏',
  '嗯……这首味道好像对了',
  '让我猜猜你现在想听什么',
  '别急，好旋律不怕晚',
  '感觉要来了，就在下一首',
  '正在调动我的音乐直觉',
  '快了，音符排队上车中',
  '等我，在跟某首歌对个眼神',
  '耳朵已经忙起来了，马上好',
]

export const CASUAL_WAITING_LINES = [
  '嗯，我在听',
  '等我想想怎么回你这句话',
  '这句我得认真回',
  '让我慢慢想一下',
  '我先认真听完这句话',
  '有点懂你的意思了',
  '我在想怎么说更贴近一点',
  '等我把话放软一点',
  '我听见了，等我一下',
  '这句我想认真想想',
  '我在心里过一遍',
  '让我找个更像朋友的说法',
]

function looksLikeMusicRelated(text: string): boolean {
  return /推|推荐|来几首|听什么|听啥|值得听|适合听|想听|能听|放点|放首|来点|歌|曲|歌单|music|song|慢|快|安静|热闹|循环|舒缓|轻|燃|治愈|怀旧|睡前|通勤|粤语|英文|欧美|韩|日语|kpop|雨天|发呆/i.test(text)
}

export function pickWaitingLineFor(text: string) {
  const pool = looksLikeMusicRelated(text) ? WAITING_LINES : CASUAL_WAITING_LINES
  return pool[stableInt(text, pool.length)] ?? CASUAL_WAITING_LINES[0]
}
