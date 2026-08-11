export class NeteaseAuthRequiredError extends Error {
  constructor(message = '请先登录网易云后再让 Echo 推荐歌。') {
    super(message)
    this.name = 'NeteaseAuthRequiredError'
  }
}
