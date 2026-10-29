'use client'

import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { $createTextNode, $insertNodes, type TextNode } from 'lexical'
import { $createLinkNode } from '@lexical/link'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  useBasicTypeaheadTriggerMatch,
  type MenuRenderFn,
} from '@lexical/react/LexicalTypeaheadMenuPlugin'
import { matchMentionContacts, mentionLabel, type MailContact } from '../../lib/mail/contacts-shared'
import styles from './ComposeWindow.module.css'

/**
 * Gmail-style tagging in the email body: type "@" and the first letters of a
 * name, pick the person (Enter, Tab, click; arrows move, Escape closes), and
 * "@Their Name" goes in as a mailto: link to their address. Recipients are
 * left alone. Suggestions come from the same people list as the To / Cc / Bcc
 * fields.
 */

class MentionOption extends MenuOption {
  readonly contact: MailContact
  constructor(contact: MailContact) {
    super(contact.email)
    this.contact = contact
  }
}

interface Props {
  /** People to suggest; null while still loading. */
  contacts: readonly MailContact[] | null
  /** Called when a tag is started, so the people list loads. */
  onWantContacts: () => void
}

export function EmailMentionPlugin({ contacts, onWantContacts }: Props) {
  const [editor] = useLexicalComposerContext()
  const [query, setQuery] = useState<string | null>(null)
  // "@" then a letter, after a space or at the start of a line, so addresses
  // such as jo@example.com never open it. Spaces allowed for "@John Sm".
  const triggerFn = useBasicTypeaheadTriggerMatch('@', { minLength: 1, maxLength: 40, allowWhitespace: true })

  const options = useMemo(
    () => (contacts && query ? matchMentionContacts(contacts, query).map((contact) => new MentionOption(contact)) : []),
    [contacts, query],
  )
  const loading = contacts === null && query !== null

  const renderMenu: MenuRenderFn<MentionOption> = (anchorRef, { selectedIndex, selectOptionAndCleanUp, setHighlightedIndex }) => {
    if (!anchorRef.current) return null
    return createPortal(
      <ul className={styles.mentionList} aria-label="People to tag">
        {loading ? (
          <li className={styles.mentionStatus} role="presentation">
            Loading people…
          </li>
        ) : (
          options.map((option, i) => (
            <li
              key={option.key}
              id={`typeahead-item-${i}`}
              ref={option.setRefElement}
              role="option"
              aria-selected={selectedIndex === i}
              className={styles.mentionOption}
              // Keep the caret in the body so the click lands as a pick.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setHighlightedIndex(i)}
              onClick={() => {
                setHighlightedIndex(i)
                selectOptionAndCleanUp(option)
              }}
            >
              {option.contact.name ? <span className={styles.mentionName}>{option.contact.name}</span> : null}
              <span className={styles.mentionEmail}>{option.contact.email}</span>
            </li>
          ))
        )}
      </ul>,
      anchorRef.current,
    )
  }

  return (
    <LexicalTypeaheadMenuPlugin<MentionOption>
      options={options}
      triggerFn={triggerFn}
      onQueryChange={(text) => {
        setQuery(text)
        if (text !== null) onWantContacts()
      }}
      onSelectOption={(option: MentionOption, textNode: TextNode | null, closeMenu: () => void) => {
        // Runs inside the menu's editor.update.
        const link = $createLinkNode(`mailto:${option.contact.email}`)
        const text = $createTextNode(`@${mentionLabel(option.contact)}`)
        if (textNode) text.setStyle(textNode.getStyle())
        link.append(text)
        if (textNode) textNode.replace(link)
        else $insertNodes([link])
        const space = $createTextNode(' ')
        link.insertAfter(space)
        space.select(1, 1)
        closeMenu()
        editor.focus()
      }}
      // A custom panel only while there is something to show; otherwise the
      // menu draws nothing and arrows, Enter and Escape behave as normal.
      menuRenderFn={loading || options.length > 0 ? renderMenu : undefined}
      anchorClassName={styles.mentionAnchor}
    />
  )
}
