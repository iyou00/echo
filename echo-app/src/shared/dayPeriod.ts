export type ChineseDayPeriod = 'late_night' | 'morning' | 'forenoon' | 'noon' | 'afternoon' | 'evening' | 'night'

export function chineseDayPeriod(date = new Date()): ChineseDayPeriod {
  const hour = date.getHours()
  if (hour < 6) return 'late_night'
  if (hour < 9) return 'morning'
  if (hour < 12) return 'forenoon'
  if (hour < 14) return 'noon'
  if (hour < 18) return 'afternoon'
  if (hour < 20) return 'evening'
  return 'night'
}

export function chineseDayPeriodLabel(date = new Date()): string {
  switch (chineseDayPeriod(date)) {
    case 'late_night':
      return '深夜'
    case 'morning':
      return '早上'
    case 'forenoon':
      return '上午'
    case 'noon':
      return '中午'
    case 'afternoon':
      return '下午'
    case 'evening':
      return '傍晚'
    case 'night':
      return '晚上'
  }
}
