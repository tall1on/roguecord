export const SERVER_PERMISSION_KEYS = [
  'manage_server_settings',
  'manage_storage_settings',
  'manage_channels',
  'manage_roles',
  'moderate_members',
  'manage_messages',
  'manage_folder_files',
  'send_rss_messages'
] as const

export type ServerPermission = typeof SERVER_PERMISSION_KEYS[number]

export type ServerPermissionCategory = 'administration' | 'moderation' | 'content'

export type ServerPermissionMetadata = {
  key: ServerPermission
  label: string
  description: string
  category: ServerPermissionCategory
}

export const SERVER_PERMISSION_CATEGORY_LABELS: Record<ServerPermissionCategory, string> = {
  administration: 'Administration',
  moderation: 'Moderation',
  content: 'Content & Channels'
}

export const SERVER_PERMISSION_METADATA: ServerPermissionMetadata[] = [
  {
    key: 'manage_server_settings',
    label: 'Manage server settings',
    description: 'Update server overview settings such as title, icon, rules channel, and welcome channel.',
    category: 'administration'
  },
  {
    key: 'manage_storage_settings',
    label: 'Manage storage settings',
    description: 'View, test, and update local or S3-compatible storage configuration.',
    category: 'administration'
  },
  {
    key: 'manage_channels',
    label: 'Manage channels',
    description: 'Create, delete, and reorder channels and categories.',
    category: 'content'
  },
  {
    key: 'manage_roles',
    label: 'Manage roles',
    description: 'Create roles, edit lower roles, reorder lower roles, and assign manageable roles to lower members.',
    category: 'administration'
  },
  {
    key: 'moderate_members',
    label: 'Moderate members',
    description: 'Kick or ban lower members and optionally remove their message history.',
    category: 'moderation'
  },
  {
    key: 'manage_messages',
    label: 'Manage messages',
    description: 'Delete messages posted by other users while preserving self-delete for everyone.',
    category: 'moderation'
  },
  {
    key: 'manage_folder_files',
    label: 'Manage folder files',
    description: 'Upload and delete files in folder channels.',
    category: 'content'
  },
  {
    key: 'send_rss_messages',
    label: 'Send RSS-channel messages',
    description: 'Post manually in RSS channels, which are otherwise read-only.',
    category: 'content'
  }
]

export const ALL_SERVER_PERMISSIONS: ServerPermission[] = [...SERVER_PERMISSION_KEYS]
export const ALL_USERS_ROLE_KEY = 'all_users'
export const ADMIN_ROLE_KEY = 'admin'

export type PermissionRoleLike = {
  key?: string | null
  permissions?: readonly string[] | string | null
  position?: number | null
}

const SUPPORTED_PERMISSION_SET = new Set<string>(SERVER_PERMISSION_KEYS)

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
}

export const normalizeRoleKey = (value: unknown): string => {
  if (typeof value !== 'string') return ''
  return value.trim().toLowerCase()
}

export const isAdminRoleKey = (key: unknown): boolean => normalizeRoleKey(key) === ADMIN_ROLE_KEY

export const isAllUsersRoleKey = (key: unknown): boolean => normalizeRoleKey(key) === ALL_USERS_ROLE_KEY

export const isSupportedServerPermission = (value: unknown): value is ServerPermission => {
  return typeof value === 'string' && SUPPORTED_PERMISSION_SET.has(value)
}

const parsePermissionsJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
}

export const parseServerPermissions = (value: unknown): ServerPermission[] => {
  const rawPermissions = typeof value === 'string'
    ? parsePermissionsJson(value)
    : value

  if (!Array.isArray(rawPermissions)) {
    return []
  }

  const requestedPermissions = new Set(
    rawPermissions
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(isSupportedServerPermission)
  )

  return SERVER_PERMISSION_KEYS.filter((permission) => requestedPermissions.has(permission))
}

export const getLegacyRolePermissions = (key: unknown): ServerPermission[] => {
  return [...(LEGACY_ROLE_PERMISSION_MAP[normalizeRoleKey(key)] || [])]
}

export const getDefaultPermissionsForRoleKey = (key: unknown): ServerPermission[] => {
  const normalizedKey = normalizeRoleKey(key)
  if (normalizedKey === ADMIN_ROLE_KEY) {
    return [...ALL_SERVER_PERMISSIONS]
  }
  if (normalizedKey === ALL_USERS_ROLE_KEY) {
    return []
  }
  return getLegacyRolePermissions(normalizedKey)
}

export const normalizeServerPermissions = (
  key: unknown,
  permissions: unknown,
  options: { fallbackToLegacy?: boolean } = {}
): ServerPermission[] => {
  const normalizedKey = normalizeRoleKey(key)
  if (normalizedKey === ADMIN_ROLE_KEY) {
    return [...ALL_SERVER_PERMISSIONS]
  }
  if (normalizedKey === ALL_USERS_ROLE_KEY) {
    return []
  }

  const parsedPermissions = parseServerPermissions(permissions)
  if (parsedPermissions.length > 0 || !options.fallbackToLegacy) {
    return parsedPermissions
  }

  return getLegacyRolePermissions(normalizedKey)
}

export const resolveRolePermissions = (role: PermissionRoleLike): ServerPermission[] => {
  return normalizeServerPermissions(role.key, role.permissions, { fallbackToLegacy: true })
}

export const rolesIncludeAdmin = (roles: readonly PermissionRoleLike[]): boolean => {
  return roles.some((role) => isAdminRoleKey(role.key))
}

export const resolveUserPermissions = (roles: readonly PermissionRoleLike[]): ServerPermission[] => {
  if (rolesIncludeAdmin(roles)) {
    return [...ALL_SERVER_PERMISSIONS]
  }

  const permissions = new Set<ServerPermission>()
  for (const role of roles) {
    for (const permission of resolveRolePermissions(role)) {
      permissions.add(permission)
    }
  }

  return SERVER_PERMISSION_KEYS.filter((permission) => permissions.has(permission))
}

export const roleHasServerPermission = (role: PermissionRoleLike, permission: ServerPermission): boolean => {
  if (isAdminRoleKey(role.key)) {
    return true
  }
  return resolveRolePermissions(role).includes(permission)
}

export const userHasServerPermission = (
  roles: readonly PermissionRoleLike[],
  permission: ServerPermission
): boolean => {
  return resolveUserPermissions(roles).includes(permission)
}

export const getRolePosition = (role: PermissionRoleLike): number => {
  if (isAdminRoleKey(role.key)) {
    return Number.MAX_SAFE_INTEGER
  }
  if (isAllUsersRoleKey(role.key)) {
    return 0
  }

  const position = Number(role.position)
  return Number.isFinite(position) ? position : 0
}

export const getHighestRolePosition = (roles: readonly PermissionRoleLike[]): number => {
  return roles.reduce((highest, role) => Math.max(highest, getRolePosition(role)), 0)
}

export const isRoleLowerThanHighest = (
  actingRoles: readonly PermissionRoleLike[],
  targetRole: PermissionRoleLike
): boolean => {
  return getRolePosition(targetRole) < getHighestRolePosition(actingRoles)
}

export const canGrantPermissions = (
  actingRoles: readonly PermissionRoleLike[],
  permissions: readonly string[] | string | null | undefined
): boolean => {
  if (rolesIncludeAdmin(actingRoles)) {
    return true
  }

  const actingPermissions = new Set(resolveUserPermissions(actingRoles))
  return parseServerPermissions(permissions).every((permission) => actingPermissions.has(permission))
}

export const canGrantRole = (
  actingRoles: readonly PermissionRoleLike[],
  role: PermissionRoleLike
): boolean => {
  return isRoleLowerThanHighest(actingRoles, role) && canGrantPermissions(actingRoles, role.permissions)
}
