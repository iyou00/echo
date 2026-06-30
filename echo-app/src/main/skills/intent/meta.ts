function compactMetaText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s，,。.!！?？、；;：:“”"'‘’（）()【】[\]{}<>《》\-_/\\|~～]/g, '')
    .replace(/[呀啊呢嘛吧啦咯哦哇]+$/g, '')
}

export function isEchoIdentityQuestion(text: string): boolean {
  const compact = compactMetaText(text).replace(/^echo/, '')
  return /^(你)?(到底)?(是谁|是什么|叫什么|是干嘛的|能做什么|会做什么|可以做什么|有什么用)$/.test(compact)
    || /^(你)?(到底)?(是谁|是什么|叫什么).{0,12}(能做什么|会做什么|可以做什么|有什么用)$/.test(compact)
    || /^(你)?的?(设定|定位|人设)(是什么|是啥|什么|啥|怎么回事)?$/.test(compact)
    || /^(你)?(到底)?(是什么)?(设定|定位|人设)$/.test(compact)
    || /^(你)?(是怎么设定的|作为音乐伴侣能做什么|作为ai音乐伴侣能做什么)$/.test(compact)
}

export function looksLikeFreshNonAnswerTopic(text: string): boolean {
  const trimmed = text.trim()
  return isEchoIdentityQuestion(trimmed)
    || /^(?:你的|你是|echo|设置|天气|气温|温度|今天|现在).{0,24}(什么|谁|怎么|多少|几|吗|嘛|呢|？|\?)/i.test(trimmed)
}
