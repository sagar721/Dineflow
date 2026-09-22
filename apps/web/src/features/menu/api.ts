// Typed calls for the menu module. Every call goes through apiFetch, which sends
// the session cookie and the CSRF header.
import type { Currency } from '@dineflow/shared';
import { apiFetch } from '@/lib/api.ts';

export type Diet = 'veg' | 'non_veg' | 'egg' | 'none';

export type MenuCategory = {
  id: string; name: string; sortOrder: number; visible: boolean; archived: boolean; version: number;
};

export type MenuItem = {
  id: string; categoryId: string; name: string; description: string | null; priceMinor: number;
  imageUrl: string | null; diet: Diet; available: boolean; visible: boolean; archived: boolean;
  sortOrder: number; version: number;
};

export type MenuData = { currency: Currency; categories: MenuCategory[]; items: MenuItem[]; truncated: boolean };

/** Prices travel as decimal strings ("249.50"), never as floating-point numbers. */
export type ItemInput = {
  categoryId: string; name: string; description: string | null; price: string; diet: Diet;
  visible: boolean; available: boolean;
};

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const menuApi = {
  load: () => apiFetch<MenuData>('/restaurant/menu'),

  createCategory: (name: string) =>
    apiFetch<{ category: MenuCategory }>('/restaurant/menu/categories', { method: 'POST', body: { name } }),
  updateCategory: (id: string, changes: { name?: string; visible?: boolean; archived?: boolean }, version: number) =>
    apiFetch<{ category: MenuCategory }>(`/restaurant/menu/categories/${id}`, { method: 'PATCH', body: { ...changes, version } }),
  reorderCategories: (ids: string[]) =>
    apiFetch<{ categories: MenuCategory[] }>('/restaurant/menu/categories/order', { method: 'PUT', body: { ids } }),

  createItem: (input: ItemInput) =>
    apiFetch<{ item: MenuItem }>('/restaurant/menu/items', { method: 'POST', body: input }),
  updateItem: (id: string, changes: Partial<ItemInput> & { archived?: boolean }, version: number) =>
    apiFetch<{ item: MenuItem }>(`/restaurant/menu/items/${id}`, { method: 'PATCH', body: { ...changes, version } }),
  setAvailability: (id: string, available: boolean) =>
    apiFetch<{ item: MenuItem }>(`/restaurant/menu/items/${id}/availability`, { method: 'PATCH', body: { available } }),
  uploadImage: (id: string, contentType: string, base64: string) =>
    apiFetch<{ item: MenuItem }>(`/restaurant/menu/items/${id}/image`,
      { method: 'PUT', body: { contentType, data: base64 } }),
  removeImage: (id: string) =>
    apiFetch<{ item: MenuItem }>(`/restaurant/menu/items/${id}/image`, { method: 'DELETE' }),
};

/** Minor units to the decimal string an input shows: 24950 → "249.50". Integer maths only. */
export const minorToInput = (minor: number) => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;

/** Reads a File as base64 (without the data: prefix) for upload. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(reader.error ?? new Error('could not read the file'));
    reader.readAsDataURL(file);
  });
}
