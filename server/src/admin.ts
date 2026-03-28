import crypto from 'node:crypto';

let adminKey: string | null = null;

export const consumeAdminKey = (key: string): boolean => {
  if (!adminKey || key !== adminKey) {
    return false;
  }

  adminKey = null;
  return true;
};

export const setAdminKeyEnabled = (enabled: boolean): string | null => {
  if (!enabled) {
    adminKey = null;
    return adminKey;
  }

  if (!adminKey) {
    adminKey = crypto.randomUUID();
  }

  return adminKey;
};

export const getAdminKey = (): string | null => adminKey;
