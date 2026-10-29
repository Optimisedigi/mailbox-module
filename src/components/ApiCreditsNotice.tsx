'use client'

/** Where the "Use OpenAI API key for voice" toggle lives. */
export const VOICE_BILLING_SETTINGS_HREF = '/admin/globals/mail-settings'

/**
 * Shown for the whole call when the Realtime secret was minted with
 * OPENAI_API_KEY instead of the ChatGPT plan (Codex OAuth), so per-minute
 * API billing is never silent. That happens when "Use OpenAI API key for
 * voice" is on in Mail Settings. The link opens that setting in a new tab so the live call keeps
 * running.
 */
export function ApiCreditsNotice(): React.ReactElement {
  return (
    <span
      role="status"
      title="This voice call is billed to the OpenAI API key, not the ChatGPT plan."
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: '#92400e',
        border: '1px solid #d97706',
        borderRadius: 999,
        padding: '1px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      <span>Using API credits</span>
      {' · '}
      <a
        href={VOICE_BILLING_SETTINGS_HREF}
        target="_blank"
        rel="noopener noreferrer"
        title='Open Mail Settings and switch off "Use OpenAI API key for voice"'
        style={{ color: 'inherit', textDecoration: 'underline' }}
      >
        Turn off
      </a>
    </span>
  )
}
