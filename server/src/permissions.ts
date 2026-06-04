export const SERVER_PERMISSION_KEYS = [
  'manage_server_settings',
  'manage_storage_settings',
  'manage_channels',
  'manage_roles',
  'moderate_members',
  'manage_messages',
  'manage_folder_files',
  'send_rss_messages'
] as const;

export type ServerPermission = typeof SERVER_PERMISSION_KEYS[number];

export const ALL_SERVER_PERMISSIONS: ServerPermission[] = [...SERVER_PERMISSION_KEYS];

export const ALL_USERS_ROLE_KEY = 'all_users';
export const ADMIN_ROLE_KEY = 'admin';

export type PermissionRoleLike = {
  key?: string | null;
  permissions?: readonly string[] | string | null;
  position?: number | null;
};

const SUPPORTED_PERMISSION_SET = new Set<string>(SERVER_PERMISSION_KEYS);

const LEGACY_ROLE_PERMISSION_MAP: Record<string, ServerPermission[]> = {
  owner: [
    'moderate_members',
    'manage_messages',
    'manage_folder_files',
    'send_rss_messages'
  ],
  mod: [
    'moderate_members',
    'send_rss_messages'
  ],
  moderator: [
    'moderate_members',
    'send_rss_messages'
  ]
};

export const LEGACY_SERVER_ROLE_KEYS = Object.freeze(Object.keys(LEGACY_ROLE_PERMISSION_MAP));

export const normalizeRoleKey = (value: unknown): string => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

export const isAdminRoleKey = (key: unknown): boolean => normalizeRoleKey(key) === ADMIN_ROLE_KEY;

export const isAllUsersRoleKey = (key: unknown): boolean => normalizeRoleKey(key) === ALL_USERS_ROLE_KEY;

export const isSupportedServerPermission = (value: unknown): value is ServerPermission => {
  return typeof value === 'string' && SUPPORTED_PERMISSION_SET.has(value);
};

const parsePermissionsJson = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
};

export const parseServerPermissions = (value: unknown): ServerPermission[] => {
  const rawPermissions = typeof value === 'string'
    ? parsePermissionsJson(value)
    : value;

  if (!Array.isArray(rawPermissions)) {
    return [];
  }

  const requestedPermissions = new Set(
    rawPermissions
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(isSupportedServerPermission)
  );

  return SERVER_PERMISSION_KEYS.filter((permission) => requestedPermissions.has(permission));
};

export const getLegacyRolePermissions = (key: unknown): ServerPermission[] => {
  return [...(LEGACY_ROLE_PERMISSION_MAP[normalizeRoleKey(key)] || [])];
};

export const getDefaultPermissionsForRoleKey = (key: unknown): ServerPermission[] => {
  const normalizedKey = normalizeRoleKey(key);
  if (normalizedKey === ADMIN_ROLE_KEY) {
    return [...ALL_SERVER_PERMISSIONS];
  }
  if (normalizedKey === ALL_USERS_ROLE_KEY) {
    return [];
  }
  return getLegacyRolePermissions(normalizedKey);
};

export const normalizeServerRolePermissions = (
  key: unknown,
  permissions: unknown,
  options: { fallbackToLegacy?: boolean } = {}
): ServerPermission[] => {
  const normalizedKey = normalizeRoleKey(key);
  if (normalizedKey === ADMIN_ROLE_KEY) {
    return [...ALL_SERVER_PERMISSIONS];
  }
  if (normalizedKey === ALL_USERS_ROLE_KEY) {
    return [];
  }

  const parsedPermissions = parseServerPermissions(permissions);
  if (parsedPermissions.length > 0 || !options.fallbackToLegacy) {
    return parsedPermissions;
  }

  return getLegacyRolePermissions(normalizedKey);
};

export const serializeServerRolePermissions = (
  key: unknown,
  permissions: unknown,
  options: { fallbackToLegacy?: boolean } = {}
): string => {
  return JSON.stringify(normalizeServerRolePermissions(key, permissions, options));
};

export const resolveRolePermissions = (role: PermissionRoleLike): ServerPermission[] => {
  return normalizeServerRolePermissions(role.key, role.permissions, { fallbackToLegacy: true });
};

export const roleHasPermission = (role: PermissionRoleLike, permission: ServerPermission): boolean => {
  if (isAdminRoleKey(role.key)) {
    return true;
  }
  return resolveRolePermissions(role).includes(permission);
};

export const rolesIncludeAdmin = (roles: readonly PermissionRoleLike[]): boolean => {
  return roles.some((role) => isAdminRoleKey(role.key));
};

export const resolveUserPermissions = (roles: readonly PermissionRoleLike[]): ServerPermission[] => {
  if (rolesIncludeAdmin(roles)) {
    return [...ALL_SERVER_PERMISSIONS];
  }

  const permissions = new Set<ServerPermission>();
  for (const role of roles) {
    for (const permission of resolveRolePermissions(role)) {
      permissions.add(permission);
    }
  }

  return SERVER_PERMISSION_KEYS.filter((permission) => permissions.has(permission));
};

export const userHasPermission = (
  roles: readonly PermissionRoleLike[],
  permission: ServerPermission
): boolean => {
  return resolveUserPermissions(roles).includes(permission);
};

export const getRolePosition = (role: PermissionRoleLike): number => {
  if (isAdminRoleKey(role.key)) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (isAllUsersRoleKey(role.key)) {
    return 0;
  }

  const position = Number(role.position);
  return Number.isFinite(position) ? position : 0;
};

export const getHighestRolePosition = (roles: readonly PermissionRoleLike[]): number => {
  return roles.reduce((highest, role) => Math.max(highest, getRolePosition(role)), 0);
};

export const getHighestRole = <T extends PermissionRoleLike>(roles: readonly T[]): T | undefined => {
  return [...roles].sort((left, right) => getRolePosition(right) - getRolePosition(left))[0];
};

export const isRoleLowerThanHighest = (
  actingRoles: readonly PermissionRoleLike[],
  targetRole: PermissionRoleLike
): boolean => {
  return getRolePosition(targetRole) < getHighestRolePosition(actingRoles);
};

export const areRolesLowerThanHighest = (
  actingRoles: readonly PermissionRoleLike[],
  targetRoles: readonly PermissionRoleLike[]
): boolean => {
  return targetRoles.every((role) => isRoleLowerThanHighest(actingRoles, role));
};

export const canManageRole = (
  actingRoles: readonly PermissionRoleLike[],
  targetRole: PermissionRoleLike
): boolean => {
  return userHasPermission(actingRoles, 'manage_roles') && isRoleLowerThanHighest(actingRoles, targetRole);
};

export const canManageMemberWithRoles = (
  actingRoles: readonly PermissionRoleLike[],
  targetRoles: readonly PermissionRoleLike[]
): boolean => {
  return userHasPermission(actingRoles, 'manage_roles')
    && getHighestRolePosition(targetRoles) < getHighestRolePosition(actingRoles);
};

export const canGrantPermissions = (
  actingRoles: readonly PermissionRoleLike[],
  permissions: readonly string[] | string | null | undefined
): boolean => {
  if (rolesIncludeAdmin(actingRoles)) {
    return true;
  }

  const actingPermissions = new Set(resolveUserPermissions(actingRoles));
  return parseServerPermissions(permissions).every((permission) => actingPermissions.has(permission));
};

export const canGrantRole = (
  actingRoles: readonly PermissionRoleLike[],
  role: PermissionRoleLike
): boolean => {
  return isRoleLowerThanHighest(actingRoles, role) && canGrantPermissions(actingRoles, role.permissions);
};

export const canGrantRoles = (
  actingRoles: readonly PermissionRoleLike[],
  roles: readonly PermissionRoleLike[]
): boolean => {
  return roles.every((role) => canGrantRole(actingRoles, role));
};
