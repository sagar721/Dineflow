// Where validated menu images live (design/00 §3.5).
//
// The API is the only writer. Keys are built here from the restaurant id of the
// authenticated request and a fresh random name, never from anything a client
// sent, so one restaurant cannot write into another's folder.
import { randomBytes } from 'node:crypto';

export interface ImageStore {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  remove(key: string): Promise<void>;
  publicUrl(key: string): string;
}

/** A new key under the restaurant's own prefix. Matches the database's image_path check. */
export function menuImageKey(restaurantId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(restaurantId)) throw new Error('invalid restaurant id');
  return `restaurants/${restaurantId}/menu/${randomBytes(16).toString('hex')}.webp`;
}

/** Supabase Storage over its REST API, authenticated with the server-only service key. */
export class SupabaseImageStore implements ImageStore {
  readonly #url: string;
  readonly #serviceKey: string;
  readonly #bucket: string;
  readonly #fetch: typeof fetch;

  constructor(options: { url: string; serviceKey: string; bucket: string; fetchImpl?: typeof fetch }) {
    this.#url = options.url.replace(/\/$/, '');
    this.#serviceKey = options.serviceKey;
    this.#bucket = options.bucket;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    const response = await this.#fetch(`${this.#url}/storage/v1/object/${this.#bucket}/${key}`, {
      method: 'POST',
      headers: {
        apikey: this.#serviceKey,
        authorization: `Bearer ${this.#serviceKey}`,
        'content-type': contentType,
        // Keys are random and new; an existing object means something is wrong.
        'x-upsert': 'false',
        // Content-addressed by a random name, so it never changes: cache for a year.
        'cache-control': 'max-age=31536000',
      },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`image storage refused the upload (${response.status})`);
  }

  async remove(key: string): Promise<void> {
    const response = await this.#fetch(`${this.#url}/storage/v1/object/${this.#bucket}`, {
      method: 'DELETE',
      headers: {
        apikey: this.#serviceKey,
        authorization: `Bearer ${this.#serviceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ prefixes: [key] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`image storage refused the removal (${response.status})`);
  }

  publicUrl(key: string): string {
    return `${this.#url}/storage/v1/object/public/${this.#bucket}/${key}`;
  }
}

/** In-memory store for tests and for inspecting exactly what would be stored. */
export class MemoryImageStore implements ImageStore {
  readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  async put(key: string, bytes: Buffer, contentType: string): Promise<void> {
    if (this.objects.has(key)) throw new Error('object exists');
    this.objects.set(key, { bytes, contentType });
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  publicUrl(key: string): string {
    return `https://images.test/${key}`;
  }
}
