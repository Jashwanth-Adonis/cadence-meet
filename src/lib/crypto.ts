const PBKDF2_ITERATIONS = 310_000;
const VAULT_VERIFIER_TOKEN = 'CADENCE_VAULT_VERIFIED_V1';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function generateSalt(): string {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

export async function deriveMasterKey(passphrase: string, saltBase64: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  const saltBytes = base64ToBytes(saltBase64);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes.buffer as ArrayBuffer,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function exportSessionKey(key: CryptoKey): Promise<string> {
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return JSON.stringify(jwk);
}

export async function importSessionKey(jwkJson: string): Promise<CryptoKey> {
  const jwk = JSON.parse(jwkJson) as JsonWebKey;
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

export async function createVaultVerifier(key: CryptoKey): Promise<string> {
  const { iv, ciphertext } = await encryptString(key, VAULT_VERIFIER_TOKEN);
  return `${iv}:${ciphertext}`;
}

export async function verifyVaultPassphrase(key: CryptoKey, verifier: string): Promise<boolean> {
  try {
    const parts = verifier.split(':');
    if (parts.length !== 2) return false;
    const decrypted = await decryptString(key, parts[0], parts[1]);
    return decrypted === VAULT_VERIFIER_TOKEN;
  } catch {
    return false;
  }
}

export async function encryptString(
  key: CryptoKey,
  plaintext: string
): Promise<{ iv: string; ciphertext: string }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const encoded = new TextEncoder().encode(plaintext);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    encoded
  );
  return {
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
}

export async function decryptString(
  key: CryptoKey,
  ivBase64: string,
  ciphertextBase64: string
): Promise<string> {
  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(decrypted);
}

export async function encryptJson(
  key: CryptoKey,
  data: unknown
): Promise<{ iv: string; ciphertext: string }> {
  return encryptString(key, JSON.stringify(data));
}

export async function decryptJson<T>(
  key: CryptoKey,
  ivBase64: string,
  ciphertextBase64: string
): Promise<T> {
  const json = await decryptString(key, ivBase64, ciphertextBase64);
  return JSON.parse(json) as T;
}

export async function encryptBinary(
  key: CryptoKey,
  buffer: ArrayBuffer
): Promise<{ iv: Uint8Array; ciphertext: ArrayBuffer }> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    buffer
  );
  return { iv, ciphertext };
}

export async function decryptBinary(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: ArrayBuffer
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv.buffer as ArrayBuffer },
    key,
    ciphertext
  );
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}
