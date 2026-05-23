import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

// AES-256-GCM token encryption. Key is derived from API_KEY_HASH_SALT via HKDF
// with a distinct info label so it never collides with the tenant-id-hash salt
// usage. IV is 12 bytes (random per encryption), tag is 16 bytes (standard GCM).

const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HKDF_INFO = "github-mcp-auth oauth token encryption v1";

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;
  const salt = process.env.API_KEY_HASH_SALT;
  if (!salt || salt.length < 32) {
    throw new Error("API_KEY_HASH_SALT must be set and at least 32 chars");
  }
  const derived = hkdfSync("sha256", Buffer.from(salt), Buffer.alloc(0), HKDF_INFO, KEY_LENGTH);
  cachedKey = Buffer.from(derived);
  return cachedKey;
}

export interface EncryptedToken {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function encryptToken(plaintext: string): EncryptedToken {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`unexpected GCM tag length: ${tag.length}`);
  }
  return { ciphertext, iv, tag };
}

export function decryptToken(enc: EncryptedToken): string {
  const key = getKey();
  const decipher = createDecipheriv("aes-256-gcm", key, enc.iv);
  decipher.setAuthTag(enc.tag);
  const plaintext = Buffer.concat([decipher.update(enc.ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
