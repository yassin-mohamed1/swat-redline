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

/**
 * Return active catalogue callsigns that are not already held by an active
 * appointment. The editor adds the selected member's current callsign back
 * so an existing appointment can be edited without changing its callsign.
 */
export function availableCallsigns(catalogRows, assignments) {
  const used = new Set(
    (Array.isArray(assignments) ? assignments : [])
      .filter(item => item?.status === "assigned" && item?.callsign)
      .map(item => String(item.callsign).trim().toLowerCase())
  );
  const unique = new Set();
  for (const row of Array.isArray(catalogRows) ? catalogRows : []) {
    if (row?.is_active === false) continue;
    const value = String(row?.callsign || "").trim();
    if (!/^Alpha (0|[1-9][0-9]*)$/.test(value) || used.has(value.toLowerCase())) continue;
    unique.add(value);
  }
  return [...unique].sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)));
}

/**
 * Identify the database's final race-condition guard for active callsigns.
 */
export function isDuplicateCallsignViolation(error) {
  const message = String(error?.diagnostic?.message || error?.message || "");
  return String(error?.code || "") === "23505" &&
    message.includes("staff_assignments_callsign_unique_idx");
}
