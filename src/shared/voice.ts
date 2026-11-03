/**
 * The reviewer's voice: how the review comments an agent drafts for them
 * (`--pr-comment`) should read. One text, per human, kept in the shared DB
 * behind `/api/settings` and shipped with every delivery on a pull request,
 * so an edit lands on the agent's next suggestion. Empty means the default.
 */

/** Written as the reviewer's own standing instructions to the agent. */
export const DEFAULT_VOICE = `Write it the way I'd type a review comment at the line: one or two short sentences, the point first, then stop. "This resets the streak on late completions. Should it?" is a comment. A paragraph that states the finding, explains why it matters and proposes the fix is a report; I rewrite those every time.

Sound like a teammate, not a model. Direct about the issue, concrete about the fix, kind to the person. Plain words, contractions, sentences of different lengths. "I think" or "probably" when I'm actually unsure, never softening for its own sake. A real question is often the whole comment. Start a nit with "nit:". Name the fix only when it isn't obvious; if it fits the anchored lines, put it in a \`\`\`suggestion block instead of describing it.

Giveaways to avoid: em-dashes; "Consider..." or "It might be worth..."; "not X but Y"; "I noticed that"; "it's important to note"; stacked hedges ("perhaps we might want to"); lists of three for the sake of three; bold; praise before the point; restating what the diff shows; "robust", "leverage", "ensure", "streamline"; trailing "-ing" riders ("...ensuring consistency"); sign-offs like "let me know".`

/** It rides every poll prompt on a pull request, so it stays short. */
export const VOICE_MAX = 1500

/**
 * A stored or submitted voice as the prompt uses it: trimmed, or null for
 * "the default" (absent, empty, not a string, or over the cap, which a
 * client never sends but an edited DB row could hold).
 */
export function normalizeVoice(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '' || text.length > VOICE_MAX) return null
  return text
}

/** The voice the agent reads: the reviewer's own, or the default. */
export function effectiveVoice(value: unknown): string {
  return normalizeVoice(value) ?? DEFAULT_VOICE
}
