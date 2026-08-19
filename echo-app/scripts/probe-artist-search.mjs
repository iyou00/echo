// 复现 Echo 的歌手验证搜索：cloudsearch(type=100) + 歌曲搜索(type=1)，匿名即可。
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const netease = require('@neteasecloudmusicapienhanced/api')

const keyword = process.argv[2] ?? '陈默之'

const artistSearch = await netease.cloudsearch({ keywords: keyword, type: 100, limit: 3, offset: 0, timestamp: Date.now() })
const artists = artistSearch?.body?.result?.artists ?? []
console.log(`[type=100 歌手搜索] keyword=${keyword}`)
for (const artist of artists) {
  console.log(`  name=${artist.name} id=${artist.id} alias=${JSON.stringify(artist.alias ?? [])} score/热度和=${artist.score}`)
}

const songSearch = await netease.cloudsearch({ keywords: keyword, type: 1, limit: 8, offset: 0, timestamp: Date.now() })
const songs = songSearch?.body?.result?.songs ?? []
console.log(`[type=1 歌曲搜索] keyword=${keyword}`)
for (const song of songs) {
  const names = (song.artists ?? song.ar ?? []).map((item) => item.name).join(' / ')
  console.log(`  《${song.name}》 - ${names} id=${song.id}`)
}
