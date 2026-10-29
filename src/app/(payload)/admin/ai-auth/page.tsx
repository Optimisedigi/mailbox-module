/**
 * AI auth page (server shell).
 *
 * Authenticates the CMS user, then renders the client-bodied AiAuthPage
 * inside the Payload admin shell (sidebar + header). The ai-auth API
 * endpoints enforce a logged-in user on every call too.
 */

import { headers as nextHeaders } from "next/headers";
import { redirect } from "next/navigation"
import { importMap } from "../importMap.js";
import { getPayload, createLocalReq } from "payload";
import { DefaultTemplate } from "@payloadcms/next/templates";
import config from "@/payload.config";
import AiAuthPage from "@/components/AiAuthPage";
import { getVisibleEntities, getCustomViewActions } from "@/lib/visible-entities";
import AdminStepNavSetter from "@/components/AdminStepNavSetter";

export const dynamic = "force-dynamic";

export default async function Page() {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig, importMap });

  const headersList = await nextHeaders();
  const { permissions, user } = await payload.auth({ headers: headersList });
  if (!user) {
    redirect(`/admin/login?redirect=/admin/ai-auth`);
  }

  const req = await createLocalReq({ user: user ?? undefined }, payload);

  return (
    <DefaultTemplate
      i18n={req.i18n}
      payload={payload}
      permissions={permissions}
      req={req}
      user={user ?? undefined}
      viewActions={getCustomViewActions(payload)}
      visibleEntities={getVisibleEntities(payload, user)}
    >
      <AdminStepNavSetter items={[{ label: "AI Auth" }]} />
      <div className="gutter--left gutter--right">
        <AiAuthPage />
      </div>
    </DefaultTemplate>
  );
}
