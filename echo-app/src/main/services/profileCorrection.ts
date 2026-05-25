import { applyMemorySignal } from './memoryPolicy'

export async function correctProfileMemory(note: string): Promise<{ ok: boolean; message: string }> {
  const content = note.trim()
  if (!content) return { ok: false, message: '先写一句你想纠正的地方。' }
  if (content.length > 300) return { ok: false, message: '纠正内容控制在 300 字以内。' }

  await applyMemorySignal('correct_assumption', {
    target: content,
    strength: 0.3,
    note: content,
  }, {
    source: 'profile_correction',
    refreshReason: 'profile_correction',
  })

  return { ok: true, message: '我记下了，下次画像会按这个修正。' }
}
