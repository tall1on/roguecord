const AVATAR_DB_NAME = 'roguecord-avatar-storage';

const deleteAvatarDatabase = (): Promise<boolean> => {
  if (typeof window === 'undefined' || !('indexedDB' in window)) {
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.deleteDatabase(AVATAR_DB_NAME);

      request.onsuccess = () => resolve(true);
      request.onerror = () => {
        console.warn('Failed to delete legacy avatar IndexedDB store', request.error);
        resolve(false);
      };
      request.onblocked = () => {
        console.warn('Legacy avatar IndexedDB delete request was blocked');
        resolve(false);
      };
    } catch (error) {
      console.warn('Avatar IndexedDB cleanup is unavailable', error);
      resolve(false);
    }
  });
};

export const clearStoredAvatar = async (): Promise<boolean> => {
  return await deleteAvatarDatabase();
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
