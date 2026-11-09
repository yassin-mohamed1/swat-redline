/**
 * Return only roles that the current assignment operation adds to a member.
 * Existing Discord roles are intentionally excluded from appointment DMs.
 */
export function newlyGrantedRoles(requestedRoles, existingRoleIds) {
  const existing = new Set(
    (Array.isArray(existingRoleIds) ? existingRoleIds : []).map(String)
  );
  return (Array.isArray(requestedRoles) ? requestedRoles : []).filter(
    role => role && role.id != null && !existing.has(String(role.id))
  );
}
