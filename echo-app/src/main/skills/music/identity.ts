import type { Track } from '../../../types/ipc'
import { semanticTrackKey } from '../../db/semantics'

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/[《》"'“”·.,，。!！?？()（）-]/g, '')
}

/**
 * 会话碎片守卫：剥离口语功能字（代词/疑问词/语气词/口头动词）后不剩实质字的
 * 「实体候选」是句子碎片，不是歌手名或歌名。
 * 起因：「你看有没有什么歌适合我」被名词前置模式捕获、normalize 再剥尾，
 * 剩「你看有没」当歌手送去网易云校准，触发莫名其妙的追问。
 * 剥离集刻意收窄（不含 好/想/爱/行/不/一 这类可作内容字的字），保证《好想你》
 * 《你的样子》《说散就散》这类真歌名存活；代价是《你说》这类全功能字歌名会被
 * 误拒——失败模式是退回关键词搜索，可接受。
 */
const CONVERSATIONAL_FRAGMENT_CHARS = /[你我他她它您咱们这那哪什么怎吗呢嘛的吧呀啊哦嗯呗啦咯哈看听说问找给跟和是有没在就也都还又再]/g

export function isConversationalFragment(value: string): boolean {
  return normalizeText(value).replace(CONVERSATIONAL_FRAGMENT_CHARS, '').length === 0
}

export function trackKey(track: Track): string {
  return semanticTrackKey(track)
}

export function trackIdentityKeys(track: Track): string[] {
  const keys = new Set<string>()
  const neteaseId = String(track.neteaseId ?? '').trim()
  const id = String(track.id ?? '').trim()
  const title = normalizeText(track.title)
  const artist = normalizeText(track.artist)
  if (neteaseId) keys.add(`netease:${neteaseId}`)
  if (id) keys.add(`id:${id}`)
  if (title && artist) keys.add(`name:${title}::${artist}`)
  keys.add(trackKey(track))
  return Array.from(keys)
}

export function trackIdentitySet(tracks: Track[]): Set<string> {
  const keys = new Set<string>()
  for (const track of tracks) {
    for (const key of trackIdentityKeys(track)) keys.add(key)
  }
  return keys
}

export function hasTrackIdentity(keys: Set<string>, track: Track): boolean {
  return trackIdentityKeys(track).some((key) => keys.has(key))
}

export function uniqueTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  const result: Track[] = []
  for (const track of tracks) {
    if (hasTrackIdentity(seen, track)) continue
    for (const key of trackIdentityKeys(track)) seen.add(key)
    result.push(track)
  }
  return result
}

export function primaryArtist(artist: string): string {
  return artist.split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase()
}

export function diversifyByArtist(tracks: Track[], maxPerArtist: number): Track[] {
  const artistCounts = new Map<string, number>()
  return tracks.filter((track) => {
    const key = primaryArtist(track.artist)
    const count = artistCounts.get(key) ?? 0
    if (count >= maxPerArtist) return false
    artistCounts.set(key, count + 1)
    return true
  })
}
