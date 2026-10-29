import config from '@payload-config'
import { headers as getHeaders } from 'next/headers'
import { createLocalReq, getPayload } from 'payload'
import { redirect } from 'next/navigation'
import { importMap } from '../../importMap.js'
import MailApp from '../../../../../components/mail/MailApp'
import { userHasFeature } from '../../../../../lib/access'

/**
 * Single-email Mail window, opened by the reading pane's "Open in new window"
 * button: `/admin/mail/window?thread=<gmail thread id>&account=<email>`.
 * Same Mail app and actions (reply, forward, AI, archive, delete, ...), but
 * only the reading pane, and without the admin sidebar (no DefaultTemplate).
 */
export default async function Page() {
  const payload = await getPayload({ config, importMap })
  const headers = await getHeaders()
  const { user } = await payload.auth({ headers })
  if (!user) redirect('/admin/login')
  if (!userHasFeature(user, 'nav:mail')) redirect('/admin')

  const req = await createLocalReq({ user }, payload)
  const clientsResult = await payload.find({
    collection: 'clients',
    depth: 0,
    limit: 1000,
    sort: 'name',
    select: { id: true, name: true },
    overrideAccess: false,
    req,
  })
  const clients = clientsResult.docs.map((client) => ({ id: client.id, name: client.name ?? `Client ${client.id}` }))

  return <MailApp clients={clients} windowMode />
}
