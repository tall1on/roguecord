const AVATAR_DB_NAME = 'roguecord-avatar-storage';
const AVATAR_DB_VERSION = 1;
const AVATAR_STORE_NAME = 'avatars';
const AVATAR_RECORD_KEY = 'local-profile-avatar';

type AvatarRecord = {
  value: string;
};

let dbPromise: Promise<IDBDatabase | null> | null = null;

const openAvatarDatabase = (): Promise<IDBDatabase | null> => {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const request = window.indexedDB.open(AVATAR_DB_NAME, AVATAR_DB_VERSION);

        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(AVATAR_STORE_NAME)) {
            db.createObjectStore(AVATAR_STORE_NAME);
          }
        };

        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            dbPromise = null;
          };
          resolve(db);
        };

        request.onerror = () => {
          console.warn('Failed to open avatar IndexedDB store', request.error);
          resolve(null);
        };

        request.onblocked = () => {
          console.warn('Avatar IndexedDB open request was blocked');
          resolve(null);
        };
      } catch (error) {
        console.warn('Avatar IndexedDB is unavailable', error);
        resolve(null);
      }
    });
  }

  return dbPromise;
};

export const readStoredAvatar = async (): Promise<string | null> => {
  const db = await openAvatarDatabase();
  if (!db) {
    return null;
  }

  return await new Promise((resolve) => {
    try {
      const transaction = db.transaction(AVATAR_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AVATAR_STORE_NAME);
      const request = store.get(AVATAR_RECORD_KEY);

      request.onsuccess = () => {
        const result = request.result as AvatarRecord | string | undefined;
        if (typeof result === 'string') {
          resolve(result);
          return;
        }

        resolve(result?.value ?? null);
      };

      request.onerror = () => {
        console.warn('Failed to read avatar from IndexedDB', request.error);
        resolve(null);
      };
    } catch (error) {
      console.warn('Failed to start avatar IndexedDB read transaction', error);
      resolve(null);
    }
  });
};

export const saveStoredAvatar = async (avatarUrl: string | null): Promise<boolean> => {
  const db = await openAvatarDatabase();
  if (!db) {
    return false;
  }

  return await new Promise((resolve) => {
    try {
      const transaction = db.transaction(AVATAR_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(AVATAR_STORE_NAME);
      const request = avatarUrl
        ? store.put({ value: avatarUrl } satisfies AvatarRecord, AVATAR_RECORD_KEY)
        : store.delete(AVATAR_RECORD_KEY);

      request.onsuccess = () => resolve(true);
      request.onerror = () => {
        console.warn('Failed to write avatar to IndexedDB', request.error);
        resolve(false);
      };
      transaction.onerror = () => {
        console.warn('Avatar IndexedDB transaction failed', transaction.error);
        resolve(false);
      };
    } catch (error) {
      console.warn('Failed to start avatar IndexedDB write transaction', error);
      resolve(false);
    }
  });
};

export const removeLegacyStoredAvatar = () => {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    window.localStorage.removeItem('avatarUrl');
  } catch (error) {
    console.warn('Failed to remove legacy avatar from localStorage', error);
  }
};
