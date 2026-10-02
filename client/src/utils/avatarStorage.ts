const AVATAR_DB_NAME = 'roguecord-avatar-storage';
const AVATAR_STORE_NAME = 'avatars';
const AVATAR_KEY = 'current';
const DRIVER_AVATAR_KEY = 'driver';

const openAvatarDatabase = (): Promise<IDBDatabase | null> => {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(AVATAR_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(AVATAR_STORE_NAME)) {
          database.createObjectStore(AVATAR_STORE_NAME);
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        console.warn('Failed to open avatar IndexedDB store', request.error);
        resolve(null);
      };
    } catch (error) {
      console.warn('Avatar IndexedDB access is unavailable', error);
      resolve(null);
    }
  });
};

const readStoredValue = async (key: string): Promise<string | null> => {
  const database = await openAvatarDatabase();
  if (!database) {
    return null;
  }

  return await new Promise((resolve) => {
    try {
      const transaction = database.transaction(AVATAR_STORE_NAME, 'readonly');
      const store = transaction.objectStore(AVATAR_STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result;
        resolve(typeof result === 'string' ? result : null);
      };
      request.onerror = () => {
        console.warn('Failed to read stored avatar', request.error);
        resolve(null);
      };
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => database.close();
      transaction.onabort = () => database.close();
    } catch (error) {
      console.warn('Avatar IndexedDB read failed', error);
      database.close();
      resolve(null);
    }
  });
};

const saveStoredValue = async (key: string, avatarUrl: string | null): Promise<boolean> => {
  const database = await openAvatarDatabase();
  if (!database) {
    return false;
  }

  return await new Promise((resolve) => {
    try {
      const transaction = database.transaction(AVATAR_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(AVATAR_STORE_NAME);
      const request = avatarUrl === null ? store.delete(key) : store.put(avatarUrl, key);

      request.onsuccess = () => resolve(true);
      request.onerror = () => {
        console.warn('Failed to persist stored avatar', request.error);
        resolve(false);
      };
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => database.close();
      transaction.onabort = () => database.close();
    } catch (error) {
      console.warn('Avatar IndexedDB write failed', error);
      database.close();
      resolve(false);
    }
  });
};

export const readStoredAvatar = (): Promise<string | null> => readStoredValue(AVATAR_KEY);

export const saveStoredAvatar = (avatarUrl: string | null): Promise<boolean> => saveStoredValue(AVATAR_KEY, avatarUrl);

export const clearStoredAvatar = async (): Promise<boolean> => {
  return await saveStoredAvatar(null);
};

export const readStoredDriverAvatar = (): Promise<string | null> => readStoredValue(DRIVER_AVATAR_KEY);

export const saveStoredDriverAvatar = (driverAvatarUrl: string | null): Promise<boolean> => saveStoredValue(DRIVER_AVATAR_KEY, driverAvatarUrl);

export const clearStoredDriverAvatar = async (): Promise<boolean> => {
  return await saveStoredDriverAvatar(null);
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
