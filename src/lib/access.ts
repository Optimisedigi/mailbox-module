import type { FieldAccess } from "payload";

/**
 * Feature switches a non-admin user can be given (Users → Feature access).
 * Admins have every feature.
 */
export const FEATURE_KEYS = [
  { label: "Mail", value: "nav:mail" },
  { label: "Clients (edit client records and timelines)", value: "clients" },
] as const;

export type FeatureSlug = (typeof FEATURE_KEYS)[number]["value"];

type FeatureUser = { role?: unknown; featureAccess?: unknown } | null | undefined;

export function userHasFeature(user: FeatureUser, slug: FeatureSlug | string): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  return Array.isArray(user.featureAccess) && user.featureAccess.includes(slug);
}

export const adminOnlyField: FieldAccess = ({ req }) => (req.user as { role?: string } | null)?.role === "admin";
