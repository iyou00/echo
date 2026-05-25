import type { Track } from '../../../types/ipc'

export function similarTrackSearchQuery(track: Track, userText: string): string {
  return `${userText}。参考当前歌曲：${track.artist}《${track.title}》。来一首相似感觉的歌。`
}
