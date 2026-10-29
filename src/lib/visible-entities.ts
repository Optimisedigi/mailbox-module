/**
 * Helper for the custom admin pages that render Payload's <DefaultTemplate>.
 *
 * Each of those pages has to pass `visibleEntities` (lists of collection /
 * global slugs to render in the nav). The previous implementation used:
 *
 *   .filter((c) => !c.admin?.hidden)
 *
 * which silently broke once we started using FUNCTIONS for `admin.hidden`
 * (e.g. `hideUnlessFeature("clients")`) — `!function` is always `false`,
 * so EVERY collection got hidden, leaving the sidebar empty on those
 * custom pages. This helper resolves `admin.hidden` against the actual
 * user (calling it if it's a function) so feature-gated entities show up
 * for users who have access.
 */
import type { Payload } from "payload";

type AnyEntity = { slug: string; admin?: { hidden?: unknown } };

function isVisibleForUser(entity: AnyEntity, user: any): boolean {
  const hidden = entity.admin?.hidden;
  if (hidden === true) return false;
  if (typeof hidden === "function") {
    try {
      // Payload calls collection-level admin.hidden with `{ user }`
      const result = (hidden as (args: { user: any }) => boolean)({ user });
      return !result;
    } catch {
      // If it throws (unexpected user shape), default to visible — better
      // to show a feature the user shouldn't see than to render an empty
      // sidebar with no way out.
      return true;
    }
  }
  return true;
}

export function getVisibleEntities(payload: Payload, user: any) {
  return {
    collections: payload.config.collections
      .filter((c) => isVisibleForUser(c as AnyEntity, user))
      .map((c) => c.slug),
    globals: payload.config.globals
      .filter((g) => isVisibleForUser(g as AnyEntity, user))
      .map((g) => g.slug),
  };
}

/**
 * Custom admin pages that render `<DefaultTemplate>` directly bypass
 * Payload's `getRouteData` path, which is where the global
 * `admin.components.actions` array (notifications bell, user-display name)
 * normally gets piped into `viewActions`. Without it, the top-right action
 * cluster in the admin header renders empty on those pages.
 *
 * Pass the result of this helper as `viewActions` to `DefaultTemplate` so
 * every custom page shows the same breadcrumb-on-left / actions-on-right
 * header as the rest of the admin.
 */
export function getCustomViewActions(payload: Payload): string[] {
  const actions = payload.config.admin?.components?.actions ?? [];
  return actions.filter((a): a is string => typeof a === "string");
}

