# Client list (optional extension)

> [!NOTE]
> **Optional.** Mail works without any client list: you get a full mailbox. With clients, it also files client email, alerts you to new client email and can use client facts in AI drafts. Connecting Mail to a client list system you already have **may need a separate implementation** on your side; this page describes the contract.

## What Mail needs from a client

Client matching (`src/lib/mail/client-matching.ts`, loaded by `loadClientDomainIndex()` in `src/lib/mail/store.ts`) reads a `clients` collection with these fields:

| Field | Type | Used for |
| --- | --- | --- |
| `name` | text | Labels, prompts. |
| `websiteUrl` | text | Its domain (`www.` stripped) matches email addresses. |
| `contactEmail` | email | Its domain matches (or the exact address on gmail.com etc.). |
| `additionalContacts[].email` | array of `{ name, email }` | Same as `contactEmail`, one per contact. |
| `isActive` | checkbox | When two clients share a domain, the active one wins. |

Matching rules: exact domain, subdomains roll up to the most specific client domain, shared providers (gmail.com, outlook.com, bigpond.com…) only match exact addresses, your own domains (`MAIL_OWN_DOMAINS` plus the mailbox's own domain) never match, and ties stay unmatched. Users can override per sender or per `@domain` in Mail.

## Three ways to provide clients

1. **Use the bundled list.** If your app has no `clients` collection, `mailboxPlugin()` adds a simple one (the fields above plus an *Emails* tab). Nothing else to do.
2. **Use your own Payload `clients` collection.** Keep the slug `clients` and add the fields above (same names). The plugin will not replace it. Add the Mail tab to it if you want it:
   ```ts
   { name: 'emailsPanel', type: 'ui', admin: { components: { Field: './mailbox-module/components/mail/ClientEmailsPanel' } } }
   ```
3. **Clients live in another system (CRM, ERP…).** Either sync them into the `clients` collection on a schedule (simplest; Mail's relationships point at `clients` ids), or change `loadClientDomainIndex()` in `src/lib/mail/store.ts` to build the index from your source. Keep returning numeric ids that exist in `clients`, because stored emails, briefs and summaries reference them.

## Extension hooks

`src/extensions/client-list.ts` exports `clientListExtension`. Both hooks are optional:

```ts
export const clientListExtension: ClientListExtension = {
  // Extra facts for "Use client data" in Write with AI. Only client-safe facts.
  async loadClientFacts({ payload, clientId, now }) {
    const crm = await myCrm.getClient(clientId)
    return [
      `Services we provide: ${crm.services.join(', ')}`,
      `Account manager: ${crm.manager}`,
    ]
  },
  // "Add to timeline" next to a key date in a client's email brief.
  async appendTimelineEntry({ clientId, day, description, addedBy }) {
    const added = await myCrm.addTimelineEvent(clientId, { day, description, addedBy })
    return { added }
  },
}
```

| Hook | Without it |
| --- | --- |
| `loadClientFacts` | *Use client data* sends the client name and its last three email-timeline summaries. |
| `appendTimelineEntry` | *Add to timeline* answers "Client timelines are not connected in this app." (HTTP 501). |

Everything you return from `loadClientFacts` can be quoted to the client by the model, so leave out internal figures, notes and anything confidential. The block is capped at 4,000 characters.
