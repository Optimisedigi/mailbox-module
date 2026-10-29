/**
 * Credential store, backed by the ai-credentials Payload collection.
 *
 * AES-256-GCM encrypts the credential blob server-side. The encryption key
 * is read from CRED_ENCRYPTION_KEY (32 hex bytes = 64 chars). Set this on
 * Vercel for production and in .env.local for dev.
 *
 * In-memory refresh-locks prevent concurrent OAuth refreshes from racing
 * within a single Vercel function instance. Cross-instance safety is the
 * resolver's responsibility (and the OAuth refresh endpoint's idempotency).
 */

import crypto from "crypto";
import { getPayload } from "payload";
import config from "@/payload.config";
import type { Credential } from "./types";
import type { ProviderName } from "../registry";

const COLLECTION = "ai-credentials" as any;

function getEncryptionKey(): Buffer {
  const hex = process.env.CRED_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "CRED_ENCRYPTION_KEY not set. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\" and add to env.",
    );
  }
  if (hex.length !== 64) {
    throw new Error("CRED_ENCRYPTION_KEY must be 64 hex characters (32 bytes).");
  }
  return Buffer.from(hex, "hex");
}

interface Envelope {
  v: 1;
  iv: string;        // base64
  tag: string;       // base64
  ciphertext: string; // base64
}

function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const env: Envelope = {
    v: 1,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: enc.toString("base64"),
  };
  return JSON.stringify(env);
}

function decrypt(blob: string): string {
  const env = JSON.parse(blob) as Envelope;
  if (env.v !== 1) throw new Error(`Unknown credential envelope version: ${env.v}`);
  const key = getEncryptionKey();
  const iv = Buffer.from(env.iv, "base64");
  const tag = Buffer.from(env.tag, "base64");
  const ciphertext = Buffer.from(env.ciphertext, "base64");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return dec.toString("utf8");
}

/* ---------- Refresh locks (per-process) ---------- */

const refreshLocks = new Map<ProviderName, Promise<Credential>>();

export function setRefreshLock<T extends Credential>(provider: ProviderName, p: Promise<T>): Promise<T> {
  refreshLocks.set(provider, p as Promise<Credential>);
  const clearLock = () => {
    if (refreshLocks.get(provider) === (p as Promise<Credential>)) refreshLocks.delete(provider);
  };
  // Pass both handlers directly. `p.finally(clearLock)` creates a second rejected
  // promise when refresh fails, which Node reports as an unhandled rejection.
  void p.then(clearLock, clearLock);
  return p;
}

export function getRefreshLock(provider: ProviderName): Promise<Credential> | undefined {
  return refreshLocks.get(provider);
}

/* ---------- CRUD ---------- */

async function findRow(provider: ProviderName) {
  const payloadConfig = await config;
  const payload = await getPayload({ config: payloadConfig });
  const result = await payload.find({
    collection: COLLECTION,
    where: { provider: { equals: provider } },
    limit: 1,
    overrideAccess: true,
  });
  return { payload, row: result.docs?.[0] ?? null } as { payload: any; row: any };
}

export async function getCredential(provider: ProviderName): Promise<Credential | null> {
  const { row } = await findRow(provider);
  if (!row) return null;
  try {
    const decrypted = decrypt(row.data);
    return JSON.parse(decrypted) as Credential;
  } catch (err) {
    console.error(`[ai-credentials] Failed to decrypt credential for ${provider}:`, err);
    return null;
  }
}

export async function setCredential(provider: ProviderName, cred: Credential): Promise<void> {
  const encrypted = encrypt(JSON.stringify(cred));
  const { payload, row } = await findRow(provider);
  if (row) {
    await payload.update({
      collection: COLLECTION,
      id: row.id,
      data: {
        provider,
        kind: cred.kind,
        data: encrypted,
        ...(cred.kind === "oauth" ? { lastRefreshedAt: new Date().toISOString() } : {}),
      },
      overrideAccess: true,
    });
  } else {
    await payload.create({
      collection: COLLECTION,
      data: {
        provider,
        kind: cred.kind,
        data: encrypted,
        forceFallback: false,
        ...(cred.kind === "oauth" ? { lastRefreshedAt: new Date().toISOString() } : {}),
      },
      overrideAccess: true,
    });
  }
}

export async function isForceFallback(provider: ProviderName): Promise<boolean> {
  const { row } = await findRow(provider);
  return Boolean(row?.forceFallback);
}

export async function setForceFallback(provider: ProviderName, on: boolean): Promise<void> {
  const { payload, row } = await findRow(provider);
  if (!row) {
    if (!on) return;
    await payload.create({
      collection: COLLECTION,
      data: {
        provider,
        kind: "api-key",
        // Empty envelope; resolver will use env-var key. forceFallback flag is the point.
        data: encrypt(JSON.stringify({ kind: "api-key", provider, apiKey: "" })),
        forceFallback: true,
      },
      overrideAccess: true,
    });
    return;
  }
  await payload.update({
    collection: COLLECTION,
    id: row.id,
    data: { forceFallback: on },
    overrideAccess: true,
  });
}
