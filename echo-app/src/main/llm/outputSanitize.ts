export const SYSTEM_CONTEXT_TAGS = [
  'recommendation_candidates',
  'netease_status',
  'taste_curiosity',
  'today_music_session',
  'recent_day_seal',
  'current_context',
  'current_scene',
  'taste_profile_summary',
  'memory_policy',
  'memory_evidence_contract',
  'user_corrections',
  'profile_memory',
  'signal_audit',
  'soul_policy',
  'agent_soul',
  'surface_contract',
  'active_events',
  'recent_conversations',
  'recent_dialog',
  'today_listening',
  'dismissed_tracks',
  'today_conversations',
  'today_recommendations',
  'today_scene_context',
  'recent_yinyi',
  'meta',
  'output_contract',
  'current_time',
  'weather',
  'relationship',
  'music_role',
  'mood_trend',
  'current_profile',
  'last_portrait',
  'this_week_signals',
  'this_month_signals',
  'echo_should_ask',
  'kpop_undetermined',
  'recent_yinyi_summaries',
  'yesterday_seal_summary',
  'voice_moment',
  'taste_signals_recent',
  'recent_listening_segments',
  'recent_session_tracks',
  'explicit_feedback_today',
  'session_diagnosis',
  'continuation',
  'candidates',
  'date',
]

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MAX_SANITIZE_INPUT_CHARS = 30_000

function compileSystemContextPatterns(tags: readonly string[]): RegExp[] {
  return tags.flatMap((tag) => {
    const escaped = escapeRegExp(tag)
    return [
      new RegExp(`<${escaped}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${escaped}>`, 'gi'),
      new RegExp(`<${escaped}(?:\\s+[^>]*)?>[\\s\\S]*$`, 'gi'),
      new RegExp(`<\\/?${escaped}(?:\\s+[^>]*)?>`, 'gi'),
    ]
  })
}

const DEFAULT_SYSTEM_CONTEXT_PATTERNS = compileSystemContextPatterns(SYSTEM_CONTEXT_TAGS)

export function stripKnownSystemBlocks(text: string, tags = SYSTEM_CONTEXT_TAGS): string {
  let result = text.length > MAX_SANITIZE_INPUT_CHARS ? text.slice(0, MAX_SANITIZE_INPUT_CHARS) : text
  const patterns = tags === SYSTEM_CONTEXT_TAGS ? DEFAULT_SYSTEM_CONTEXT_PATTERNS : compileSystemContextPatterns(tags)
  for (const pattern of patterns) {
    result = result.replace(pattern, '')
  }
  return result.replace(/\n{3,}/g, '\n\n').trim()
}
