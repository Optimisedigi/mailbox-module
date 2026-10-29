'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { browserStorage } from '../../lib/mail/ai-prompt-store'
import { mailAccountHeaders } from '../../lib/mail/accounts-shared'
import { suggestionPeople, type MailContact } from '../../lib/mail/contacts-shared'
import { loadSavedPeople, peopleNeedRefresh, savePeople } from '../../lib/mail/people-cache'

function cleanPeople(value: unknown): MailContact[] {
  return Array.isArray(value) ? value.filter((c): c is MailContact => typeof c?.email === 'string' && typeof c?.name === 'string') : []
}

/**
 * People to suggest in an address field: the list saved in this browser (see
 * people-cache) straight away, fetched from Gmail only when there is none or
 * it is a few hours old. `contacts` is null until something is known.
 */
export function useMailContacts(account: string | undefined) {
  const [contacts, setContacts] = useState<MailContact[] | null>(null)
  const contactsRequested = useRef(false)
  const loadContacts = useCallback(() => {
    if (contactsRequested.current) return
    contactsRequested.current = true
    const storage = browserStorage()
    const key = account ?? ''
    const saved = loadSavedPeople(storage, key, Date.now())
    if (saved) setContacts(suggestionPeople(saved))
    if (!peopleNeedRefresh(saved, Date.now())) return
    fetch('/api/mail/contacts', { credentials: 'include', headers: mailAccountHeaders(account) })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as { contacts?: unknown; senders?: unknown } | null
        if (!res.ok || !data) {
          if (!saved) setContacts([])
          return
        }
        const people = { contacts: cleanPeople(data.contacts), senders: cleanPeople(data.senders) }
        savePeople(storage, key, people, Date.now())
        setContacts(suggestionPeople(people))
      })
      // Suggestions are a convenience: without them the fields work as plain text.
      .catch(() => {
        if (!saved) setContacts([])
      })
  }, [account])
  // The saved list is a quick read, so it is ready before the first letter is
  // typed; Gmail is only asked (if needed) once an address field is focused.
  useEffect(() => {
    if (contactsRequested.current) return
    const saved = loadSavedPeople(browserStorage(), account ?? '', Date.now())
    if (saved) setContacts(suggestionPeople(saved))
  }, [account])
  return { contacts, loadContacts }
}
