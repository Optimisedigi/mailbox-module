import type { Payload } from "payload";

/**
 * ─────────────────────────────────────────────────────────────────────────
 *  OPTIONAL EXTENSION: connect Mail to your own client list system.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Out of the box, Mail reads clients from the bundled `clients` collection
 * (name, website, contact emails) and that is enough for client matching,
 * client email storage, alerts, briefs and "Use client data".
 *
 * The hooks below are for data only your own system has. Each one is
 * optional; leave it undefined and Mail behaves as described next to it.
 * They may need a separate implementation for your system: nothing here
 * calls any external service by itself. See docs/client-list.md.
 */
export interface ClientListExtension {
  /**
   * Extra plain-text fact lines for "Use client data" in Write with AI, e.g.
   * "Services we provide: SEO, Google Ads" or "Monthly retainer: $2,000.00".
   * Only put in facts that are safe to quote to that client. Keep it short:
   * the whole facts block is capped at MAX_CLIENT_CONTEXT_CHARS.
   *
   * Not set: the facts block has the client name and recent email summaries.
   */
  loadClientFacts?: (args: { payload: Payload; clientId: number; now: Date }) => Promise<string[]>;

  /**
   * "Add to timeline" next to a key date in a client's email brief. Return
   * whether a new entry was added (false when it already existed).
   *
   * Not set: the button answers "Client timelines are not connected".
   */
  appendTimelineEntry?: (args: {
    payload: Payload;
    clientId: number;
    /** YYYY-MM-DD */
    day: string;
    description: string;
    /** Name or email of the user who clicked. */
    addedBy: string;
  }) => Promise<{ added: boolean }>;
}

/** Edit this object to plug in your client list system. */
export const clientListExtension: ClientListExtension = {};
