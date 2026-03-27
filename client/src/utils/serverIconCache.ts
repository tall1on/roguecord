const SERVER_ICON_CACHE_STORAGE_KEY = 'serverIconCache';
const MAX_SERVER_ICON_CACHE_ENTRIES = 100;

export interface CachedServerIconEntry {
  sourceUrl: string;
  dataUrl: string;
  updatedAt: number;
}

type ServerIconCacheRecord = Record<string, CachedServerIconEntry>;

const isBrowser = typeof window !== 'undefined';

const readServerIconCache = (): ServerIconCacheRecord => {
  if (!isBrowser) {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(SERVER_ICON_CACHE_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    const parsed = JSON.parse(raw) as ServerIconCacheRecord;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
};

const writeServerIconCache = (cache: ServerIconCacheRecord) => {
  if (!isBrowser) {
    return;
  }

  try {
    window.localStorage.setItem(SERVER_ICON_CACHE_STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Ignore storage quota and serialization errors.
  }
};

const pruneServerIconCache = (cache: ServerIconCacheRecord) => {
  const entries = Object.entries(cache);
  if (entries.length <= MAX_SERVER_ICON_CACHE_ENTRIES) {
    return cache;
  }

  const nextCache = { ...cache };
  entries
    .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(MAX_SERVER_ICON_CACHE_ENTRIES)
    .forEach(([key]) => {
      delete nextCache[key];
    });

  return nextCache;
};

const fileToDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => {
    if (typeof reader.result === 'string') {
      resolve(reader.result);
      return;
    }

    reject(new Error('Failed to read server icon as data URL'));
  };
  reader.onerror = () => reject(reader.error || new Error('Failed to read server icon as data URL'));
  reader.readAsDataURL(file);
});

export const getCachedServerIcon = (connectionId: string | null | undefined) => {
  if (!connectionId) {
    return null;
  }

  const cache = readServerIconCache();
  return cache[connectionId] || null;
};

export const cacheServerIcon = async (connectionId: string | null | undefined, sourceUrl: string | null | undefined) => {
  if (!connectionId || !sourceUrl || /^data:/i.test(sourceUrl)) {
    return null;
  }

  try {
    const response = await fetch(sourceUrl, {
      cache: 'force-cache',
      mode: 'cors'
    });

    if (!response.ok) {
      throw new Error(`Server icon request failed with status ${response.status}`);
    }

    const dataUrl = await fileToDataUrl(await response.blob());
    const nextEntry: CachedServerIconEntry = {
      sourceUrl,
      dataUrl,
      updatedAt: Date.now()
    };

    const cache = readServerIconCache();
    cache[connectionId] = nextEntry;
    writeServerIconCache(pruneServerIconCache(cache));
    return nextEntry;
  } catch {
    return getCachedServerIcon(connectionId);
  }
};

export const removeCachedServerIcon = (connectionId: string | null | undefined) => {
  if (!connectionId) {
    return;
  }

  const cache = readServerIconCache();
  if (!cache[connectionId]) {
    return;
  }

  delete cache[connectionId];
  writeServerIconCache(cache);
};
