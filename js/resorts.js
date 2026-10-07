/**
 * SnowF — Resort metadata loader.
 *
 * Single source of truth: /data/resorts.json (fetched at boot).
 * A bundled fallback copy is used if the fetch fails (e.g. file:// usage).
 * Keep the fallback in sync with data/resorts.json.
 */

const FALLBACK = {
  tochal: {
    nameFa: 'توچال', nameEn: 'Tochal', regionFa: 'تهران', fullNameFa: 'پیست توچال',
    locations: [
      { id: 'tochal-summit', nameFa: 'ایستگاه ۷ (قله)', shortFa: 'قله', zone: 'summit', alt: 3740, lat: 35.8853, lon: 51.415 },
      { id: 'tochal-mid', nameFa: 'ایستگاه ۵', shortFa: 'میانی', zone: 'mid', alt: 2935, lat: 35.86, lon: 51.408 },
      { id: 'tochal-low', nameFa: 'ایستگاه ۱', shortFa: 'پایین', zone: 'low', alt: 1900, lat: 35.8195, lon: 51.41 },
    ],
    road: { nameFa: 'جاده ولنجک', lat: 35.808, lon: 51.395 },
  },
  dizin: {
    nameFa: 'دیزین', nameEn: 'Dizin', regionFa: 'البرز', fullNameFa: 'پیست دیزین',
    locations: [
      { id: 'dizin-summit', nameFa: 'قله (سی‌چال)', shortFa: 'قله', zone: 'summit', alt: 3600, lat: 36.054, lon: 51.418 },
      { id: 'dizin-mid', nameFa: 'پارکینگ بالا', shortFa: 'میانی', zone: 'mid', alt: 3000, lat: 36.046, lon: 51.415 },
      { id: 'dizin-low', nameFa: 'پایین (هتل)', shortFa: 'پایین', zone: 'low', alt: 2650, lat: 36.035, lon: 51.41 },
    ],
    road: { nameFa: 'جاده چالوس', lat: 36.12, lon: 51.28 },
  },
  darbandsar: {
    nameFa: 'دربندسر', nameEn: 'Darbandsar', regionFa: 'تهران', fullNameFa: 'پیست دربندسر',
    locations: [
      { id: 'darbandsar-summit', nameFa: 'قله', shortFa: 'قله', zone: 'summit', alt: 3570, lat: 36.018, lon: 51.465 },
      { id: 'darbandsar-mid', nameFa: 'میان‌راه', shortFa: 'میانی', zone: 'mid', alt: 3000, lat: 36.015, lon: 51.46 },
      { id: 'darbandsar-low', nameFa: 'پایین', shortFa: 'پایین', zone: 'low', alt: 2600, lat: 36.01, lon: 51.455 },
    ],
    road: { nameFa: 'جاده فشم', lat: 35.96, lon: 51.5 },
  },
  shemshak: {
    nameFa: 'شمشک', nameEn: 'Shemshak', regionFa: 'تهران', fullNameFa: 'پیست شمشک',
    locations: [
      { id: 'shemshak-summit', nameFa: 'قله', shortFa: 'قله', zone: 'summit', alt: 3050, lat: 36.022, lon: 51.489 },
      { id: 'shemshak-mid', nameFa: 'میانی', shortFa: 'میانی', zone: 'mid', alt: 2800, lat: 36.015, lon: 51.495 },
      { id: 'shemshak-low', nameFa: 'پایین', shortFa: 'پایین', zone: 'low', alt: 2550, lat: 36.01, lon: 51.49 },
    ],
    road: { nameFa: 'جاده شمشک', lat: 35.96, lon: 51.5 },
  },
};

export const RESORT_ORDER = ['tochal', 'dizin', 'darbandsar', 'shemshak'];

/** Load resort metadata (JSON file preferred, fallback otherwise). */
export async function loadResorts() {
  try {
    const res = await fetch('./data/resorts.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.resorts && Object.keys(json.resorts).length >= 4) return json.resorts;
    throw new Error('bad-shape');
  } catch {
    return structuredCloneSafe(FALLBACK);
  }
}

function structuredCloneSafe(obj) {
  try {
    if (typeof structuredClone === 'function') return structuredClone(obj);
  } catch { /* fall through */ }
  return JSON.parse(JSON.stringify(obj));
}

export function resortIds(resorts) {
  const known = RESORT_ORDER.filter((id) => resorts && resorts[id]);
  const extra = resorts ? Object.keys(resorts).filter((id) => !RESORT_ORDER.includes(id)) : [];
  return [...known, ...extra];
}
