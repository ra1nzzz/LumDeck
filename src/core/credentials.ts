// Credential adapter: owns per-widget secret mappings, legacy plaintext
// migration to the OS vault (`LumDeck:<uid>:<key>`), per-UID serialization,
// failure propagation, and browser-preview session-only credential storage.

import * as tauri from "./tauri";

export interface WidgetSecretMapping {
  legacySettingKey: string;
  secretKey: string;
}

export const WIDGET_SECRET_MAPPINGS: Readonly<Record<string, readonly WidgetSecretMapping[]>> = {
  "github-activity": [{ legacySettingKey: "token", secretKey: "token" }],
  "gmail-unread": [{ legacySettingKey: "accessToken", secretKey: "accessToken" }],
  "instagram-followers": [{ legacySettingKey: "accessToken", secretKey: "accessToken" }],
  revenue: [{ legacySettingKey: "apiKey", secretKey: "apiKey" }],
  "stock-quote": [{ legacySettingKey: "apiKey", secretKey: "apiKey" }],
  "ai-usage": [{ legacySettingKey: "sessionKey", secretKey: "sessionKey" }],
};

const WIDGET_SECRET_MAP = new Map<string, readonly WidgetSecretMapping[]>(
  Object.entries(WIDGET_SECRET_MAPPINGS),
);

export type SecretVaultErrorCode =
  | "vault_read_failed"
  | "vault_write_failed"
  | "vault_verify_failed"
  | "vault_delete_failed"
  | "persistence_failed"
  | "invalid_secret"
  | "widget_deleted";

export class SecretVaultError extends Error {
  readonly code: SecretVaultErrorCode;

  constructor(code: SecretVaultErrorCode, message: string) {
    super(message);
    this.name = "SecretVaultError";
    this.code = code;
  }
}

export interface PersistResult {
  ok: boolean;
  error?: string;
}

export interface CredentialStorePort {
  getWidgetId?: (uid: string) => string | undefined;
  hasLegacySecret: (uid: string, legacyKey: string) => boolean;
  getLegacySecret: (uid: string, legacyKey: string) => unknown;
  commitLegacySecretCleared: (uid: string, legacyKey: string) => PersistResult;
}

export interface CredentialManagerDeps {
  store: CredentialStorePort;
  invoke?: <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  isTauri?: () => boolean;
}

export interface WidgetSecretHandle {
  getSecret: (key: string) => Promise<string | null>;
  setSecret: (key: string, value: string) => Promise<void>;
  deleteSecret: (key: string) => Promise<void>;
}

export function getWidgetSecretMappings(widgetId: string): readonly WidgetSecretMapping[] {
  return WIDGET_SECRET_MAP.get(widgetId) ?? [];
}

function secretFieldSet(widgetId: string): Set<string> {
  const keys = new Set<string>();
  for (const m of getWidgetSecretMappings(widgetId)) {
    keys.add(m.legacySettingKey);
    keys.add(m.secretKey);
  }
  return keys;
}

function setOwnProp(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * Split raw persisted settings into non-sensitive settings (`cleanSettings`)
 * and any legacy plaintext secret fields (`legacySecrets`).
 */
export function extractLegacySecrets(
  widgetId: string,
  rawSettings: Record<string, unknown>,
): { cleanSettings: Record<string, unknown>; legacySecrets: Record<string, unknown> } {
  const secretKeys = secretFieldSet(widgetId);
  const cleanSettings: Record<string, unknown> = {};
  const legacySecrets: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawSettings)) {
    if (secretKeys.has(k)) {
      setOwnProp(legacySecrets, k, v);
    } else {
      setOwnProp(cleanSettings, k, v);
    }
  }
  return { cleanSettings, legacySecrets };
}

/** Return a copy of `settings` with any secret keys for `widgetId` removed. */
export function stripSecretSettings(
  widgetId: string,
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const secretKeys = secretFieldSet(widgetId);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings)) {
    if (secretKeys.size === 0 || !secretKeys.has(k)) {
      setOwnProp(out, k, v);
    }
  }
  return out;
}

/** Redact credentials, Bearer tokens, and tokenized URL parameters from error text. */
export function sanitizeSecretError(err: unknown, knownSecrets: readonly string[] = []): string {
  let msg = err instanceof Error ? err.message : typeof err === "string" ? err : "operation failed";
  msg = msg.replace(
    /([?&](?:access_token|token|api_key|apikey|session_key|sessionKey|secret)=)[^&\s]+/gi,
    "$1[REDACTED]",
  );
  msg = msg.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
  for (const s of knownSecrets) {
    const trimmed = s.trim();
    if (trimmed) msg = msg.split(trimmed).join("[REDACTED]");
  }
  return msg || "operation failed";
}

function defaultIsTauri(): boolean {
  if (
    Object.prototype.hasOwnProperty.call(tauri, "isTauri") &&
    typeof tauri.isTauri === "function"
  ) {
    return tauri.isTauri();
  }
  if (
    Object.prototype.hasOwnProperty.call(tauri, "hasTauri") &&
    typeof tauri.hasTauri === "boolean"
  ) {
    return tauri.hasTauri;
  }
  // Support partial test mocks of core/tauri that export invoke without hasTauri/isTauri.
  return true;
}

function hasNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

export function createCredentialManager(deps: CredentialManagerDeps) {
  const invokeFn = deps.invoke ?? tauri.invoke;
  const isTauri = deps.isTauri ?? defaultIsTauri;
  const storePort = deps.store;

  // Per-UID FIFO queue so migrate/read/write/delete on the same widget never race.
  const uidQueues = new Map<string, Promise<void>>();
  // Track UIDs currently deleting or already deleted so queued/late writes cannot recreate Vault entries.
  const deletingCounts = new Map<string, number>();
  const deletedUids = new Set<string>();
  // Browser preview only: session-scoped in-memory credentials (never persisted).
  const sessionSecrets = new Map<string, string>();
  const sessionDeleted = new Set<string>();

  function isUidDeletedOrDeleting(uid: string): boolean {
    return deletedUids.has(uid) || (deletingCounts.get(uid) ?? 0) > 0;
  }

  function runSerialized<T>(uid: string, task: () => Promise<T>): Promise<T> {
    const prev = uidQueues.get(uid) ?? Promise.resolve();
    const next = prev.then(task, task);
    const tail = next.then(
      () => undefined,
      () => undefined,
    );
    uidQueues.set(uid, tail);
    void tail.then(() => {
      if (uidQueues.get(uid) === tail) uidQueues.delete(uid);
    });
    return next;
  }

  function findMappingBySecretKey(
    widgetId: string,
    secretKey: string,
  ): WidgetSecretMapping | undefined {
    return getWidgetSecretMappings(widgetId).find((m) => m.secretKey === secretKey);
  }

  async function migrateMappingUnlocked(
    uid: string,
    mapping: WidgetSecretMapping,
  ): Promise<void> {
    if (!storePort.hasLegacySecret(uid, mapping.legacySettingKey)) {
      return;
    }

    const vaultKey = `${uid}:${mapping.secretKey}`;
    let existing: string | null;
    try {
      existing = await invokeFn<string | null>("cred_get", { key: vaultKey });
    } catch {
      throw new SecretVaultError("vault_read_failed", "Could not read credential vault");
    }

    if (hasNonEmptyString(existing)) {
      const persisted = storePort.commitLegacySecretCleared(uid, mapping.legacySettingKey);
      if (!persisted.ok) {
        throw new SecretVaultError(
          "persistence_failed",
          "Vault credential kept, but failed to clear legacy setting from storage",
        );
      }
      return;
    }

    const rawLegacy = storePort.getLegacySecret(uid, mapping.legacySettingKey);
    const candidate = typeof rawLegacy === "string" ? rawLegacy.trim() : "";

    if (candidate.length > 0) {
      try {
        await invokeFn("cred_set", { key: vaultKey, secret: candidate });
      } catch {
        throw new SecretVaultError("vault_write_failed", "Could not write migrated credential");
      }

      let readBack: string | null;
      try {
        readBack = await invokeFn<string | null>("cred_get", { key: vaultKey });
      } catch {
        throw new SecretVaultError("vault_verify_failed", "Could not verify migrated credential");
      }
      if (readBack !== candidate) {
        throw new SecretVaultError("vault_verify_failed", "Migrated credential verification failed");
      }
    }

    const persisted = storePort.commitLegacySecretCleared(uid, mapping.legacySettingKey);
    if (!persisted.ok) {
      throw new SecretVaultError(
        "persistence_failed",
        "Credential stored in vault, but failed to clear legacy setting from storage",
      );
    }
  }

  async function getSecret(uid: string, widgetId: string, key: string): Promise<string | null> {
    if (isUidDeletedOrDeleting(uid)) return null;
    return runSerialized(uid, async () => {
      if (isUidDeletedOrDeleting(uid)) return null;
      const mapping = findMappingBySecretKey(widgetId, key);
      const scopedKey = `${uid}:${key}`;

      if (!isTauri()) {
        if (sessionDeleted.has(scopedKey)) return null;
        if (sessionSecrets.has(scopedKey)) return sessionSecrets.get(scopedKey)!;
        if (mapping && storePort.hasLegacySecret(uid, mapping.legacySettingKey)) {
          const raw = storePort.getLegacySecret(uid, mapping.legacySettingKey);
          if (hasNonEmptyString(raw)) return raw.trim();
        }
        return null;
      }

      if (mapping && storePort.hasLegacySecret(uid, mapping.legacySettingKey)) {
        await migrateMappingUnlocked(uid, mapping);
      }

      try {
        return await invokeFn<string | null>("cred_get", { key: scopedKey });
      } catch {
        throw new SecretVaultError("vault_read_failed", "Could not read credential vault");
      }
    });
  }

  async function setSecret(
    uid: string,
    widgetId: string,
    key: string,
    value: string,
  ): Promise<void> {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SecretVaultError("invalid_secret", "Secret value cannot be empty");
    }
    if (isUidDeletedOrDeleting(uid)) {
      throw new SecretVaultError("widget_deleted", "Cannot save credential for a deleted widget");
    }
    return runSerialized(uid, async () => {
      if (isUidDeletedOrDeleting(uid)) {
        throw new SecretVaultError("widget_deleted", "Cannot save credential for a deleted widget");
      }
      const mapping = findMappingBySecretKey(widgetId, key);
      const scopedKey = `${uid}:${key}`;

      if (!isTauri()) {
        sessionSecrets.set(scopedKey, value);
        sessionDeleted.delete(scopedKey);
        return;
      }

      try {
        await invokeFn("cred_set", { key: scopedKey, secret: value });
      } catch {
        throw new SecretVaultError("vault_write_failed", "Could not save credential to vault");
      }

      if (mapping && storePort.hasLegacySecret(uid, mapping.legacySettingKey)) {
        const persisted = storePort.commitLegacySecretCleared(uid, mapping.legacySettingKey);
        if (!persisted.ok) {
          throw new SecretVaultError(
            "persistence_failed",
            "Credential saved to vault, but failed to clear legacy setting from storage",
          );
        }
      }
    });
  }

  async function deleteSecret(uid: string, widgetId: string, key: string): Promise<void> {
    if (deletedUids.has(uid)) return;
    return runSerialized(uid, async () => {
      if (deletedUids.has(uid)) return;
      const mapping = findMappingBySecretKey(widgetId, key);
      const scopedKey = `${uid}:${key}`;

      if (!isTauri()) {
        sessionSecrets.delete(scopedKey);
        sessionDeleted.add(scopedKey);
        return;
      }

      try {
        await invokeFn("cred_delete", { key: scopedKey });
      } catch {
        throw new SecretVaultError("vault_delete_failed", "Could not delete credential from vault");
      }

      if (mapping && storePort.hasLegacySecret(uid, mapping.legacySettingKey)) {
        const persisted = storePort.commitLegacySecretCleared(uid, mapping.legacySettingKey);
        if (!persisted.ok) {
          throw new SecretVaultError(
            "persistence_failed",
            "Credential deleted from vault, but failed to clear legacy setting from storage",
          );
        }
      }
    });
  }

  async function deleteWidgetSecrets(uid: string, widgetId: string): Promise<void> {
    deletingCounts.set(uid, (deletingCounts.get(uid) ?? 0) + 1);
    return runSerialized(uid, async () => {
      try {
        const mappings = getWidgetSecretMappings(widgetId);
        if (mappings.length === 0) {
          deletedUids.add(uid);
          return;
        }

        if (!isTauri()) {
          for (const m of mappings) {
            const scopedKey = `${uid}:${m.secretKey}`;
            sessionSecrets.delete(scopedKey);
            sessionDeleted.add(scopedKey);
          }
          deletedUids.add(uid);
          return;
        }

        for (const m of mappings) {
          try {
            await invokeFn("cred_delete", { key: `${uid}:${m.secretKey}` });
          } catch {
            throw new SecretVaultError(
              "vault_delete_failed",
              "Could not delete widget credential from vault",
            );
          }
        }
        deletedUids.add(uid);
      } finally {
        const remaining = (deletingCounts.get(uid) ?? 1) - 1;
        if (remaining > 0) deletingCounts.set(uid, remaining);
        else deletingCounts.delete(uid);
      }
    });
  }

  function forWidget(uid: string, widgetId: string): WidgetSecretHandle {
    return {
      getSecret: (key) => getSecret(uid, widgetId, key),
      setSecret: (key, value) => setSecret(uid, widgetId, key, value),
      deleteSecret: (key) => deleteSecret(uid, widgetId, key),
    };
  }

  return {
    getSecret,
    setSecret,
    deleteSecret,
    deleteWidgetSecrets,
    forWidget,
  };
}
