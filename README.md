# S.W.A.T. REDLINE

Secure staff command portal for S.W.A.T. REDLINE. The application is a static single-page portal with Vercel serverless API routes, Supabase-backed shared state, and Discord OAuth/bot integrations.

## Runtime

- **Hosting:** Vercel, production alias `https://swat-redline.vercel.app`
- **Runtime:** Node.js 24.x
- **Frontend:** `index.html` (no client build step)
- **Backend:** `api/**/*.js` Vercel serverless functions
- **Shared storage:** Supabase Postgres + Storage
- **Messaging:** Discord OAuth and Discord Bot API
- **Scheduled forwarding:** Supabase `pg_cron` + `pg_net`

## Architecture

- The browser talks to same-origin `/api/*` routes only. It must never receive the Supabase service-role key or Discord bot token.
- `api/state.js` is the shared portal-state endpoint. Writes use an optimistic `updated_at` version check and preserve unknown keys for older browser sessions.
- `api/audit/log.js` appends server-authenticated audit events. The server-owned audit log is not replaced by browser-submitted state.
- `api/notifications/send.js` validates the selected record against shared state, creates a notification batch, posts to the configured Discord channel, and independently delivers DMs to the owner and opted-in active staff. The separate `publish_site_notice` action publishes a saved official site notice to `DISCORD_NOTIFICATION_CHANNEL_ID` only; it does not use the warning channel or send DMs.
- `lib/announcement-forwarder.js` forwards ordinary messages from the announcement channel to opted-in staff. Portal-generated announcement embeds are skipped here because the site notification endpoint already handles their DMs.
- `lib/request-security.js` rejects cross-origin browser mutations. Safe GET/HEAD/OPTIONS requests are not blocked.
- `api/admin/*` contains owner-only member, settings, and site-media operations.

## Required Vercel environment variables

Set these for the **Production** environment. Use the same Supabase project for all Supabase settings.

### Discord OAuth and access

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` — must match the Discord OAuth redirect URL and point to `/api/auth/discord`
- `DISCORD_GUILD_ID`
- `DISCORD_ROLE_ID` — role required for portal access
- `DISCORD_OWNER_ID` — protected portal owner ID
- `SESSION_SECRET` — strong random secret used to sign eight-hour sessions

### Discord bot and delivery

- `DISCORD_BOT_TOKEN`
- `DISCORD_BOT_ROLE_ID` — ID of the **Website** role assigned to the official REDLINE bot account; used by the portal for bot-role diagnostics and hierarchy checks
- `DISCORD_NOTIFICATION_CHANNEL_ID` — regular notification channel for operations, reports, tasks, and other standard alerts
- `DISCORD_NOTIFICATION_ROLE_ID` — role used for optional notification mentions
- `DISCORD_NOTIFICATIONS_BROADCAST_ENABLED` — set to `true` to permit opted-in member DMs; owner delivery remains independent
- `DISCORD_ANNOUNCEMENT_CHANNEL_ID` — source channel polled by the announcement forwarder; it must be the announcement room configured for the portal
- `ANNOUNCEMENT_SYNC_SECRET` — shared secret used by the scheduled forwarder
- `DISCORD_EVIDENCE_CHANNEL_ID` — optional override; defaults in code to the owner-selected Evidence Room ID
- `DISCORD_WARNING_MANAGER_ROLE_ID` — Discord role allowed to issue, review, and dismiss members through the Warnings page
- `DISCORD_WARNING_ROLE_1_ID`, `DISCORD_WARNING_ROLE_2_ID` — the only Discord warning roles; the third action is dismissal and has no third-warning role
- `DISCORD_WARNINGS_CHANNEL_ID` — channel where official warning and dismissal notices are posted\n- `CRON_SECRET` — production-only secret used by Supabase Cron to authenticate the warning-expiry worker

The site notification route posts announcements to the owner-selected Announcement Room ID and routes people/cases/investigations to the Evidence Room. Other record families retain `DISCORD_NOTIFICATION_CHANNEL_ID`. Keep `DISCORD_ANNOUNCEMENT_CHANNEL_ID` aligned with the source announcement room so the forwarder reads the same room.

### Supabase

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

**Never** place `SUPABASE_SERVICE_ROLE_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_SECRET`, or `SESSION_SECRET` in frontend code, HTML, committed files, screenshots, or public issue reports.

## Official site notices

- Official notices are created and stored in the shared `app_state.siteNotices` collection before publishing.
- Each notice has an editable title and description. The owner and Website Admin can edit or delete notices; active portal members can view them.
- Publishing uses `DISCORD_SITE_NOTICES_CHANNEL_ID`, currently configured to `1568885316566122577` (🔴 SWAT • WARNING). This is a dedicated setting separate from `DISCORD_WARNINGS_CHANNEL_ID`, even though both currently target the same Discord room.
- Publishing posts one embed to the configured site-notice channel only; it does not send member DMs.
- Editing a published notice updates every still-live Discord message associated with that notice.
- Deleting a notice removes all still-live Discord copies, then removes the notice from the portal. If a Discord deletion fails, the notice remains in the portal so the operation can be retried.
- Explicit resend publishes a new Discord message and retains earlier copies. The portal records each attempt under a unique `batch_key` and shows the latest live publication.
- Duplicate normal publishing is blocked; pending operations cannot be edited or deleted.
- No new Supabase table or migration is required. The existing `discord_notification_batches` ledger records each attempt and Discord message ID.

## Disciplinary warnings

- The Warnings portal is visible only to an active staff account with `DISCORD_WARNING_MANAGER_ROLE_ID`; the site role controls who may manage warning records, while `DISCORD_BOT_ROLE_ID` identifies the separate bot role used to execute Discord actions.
- The ladder is strictly `Warning 1` → `Warning 2` → `Dismissal`; there is no Warning 3 Discord role.
- Warning 1 and Warning 2 replace one another as the member progresses. Each warning expires 30 days after the fully delivered action; the role is removed by the Supabase `swat-warning-role-expiry` cron job, which runs every minute and retries temporary failures.
- Both the recipient's private DM and the official warnings-room announcement are required. If either delivery fails, the API attempts to restore the member's prior Discord roles and marks the action failed instead of claiming success.
- Dismissal is available only after Warning 2. The bot removes all removable member roles only when its role hierarchy allows every role to be removed; otherwise dismissal is blocked and the unmanageable roles are reported.
- `DISCORD_BOT_ROLE_ID` must match the **Website** role assigned to the official REDLINE bot account. The bot needs Manage Roles and must be above Warning 1, Warning 2, and every role it is expected to remove.
- The bot also needs View Channel, Send Messages, and Embed Links in `DISCORD_WARNINGS_CHANNEL_ID`.
- The expiry worker runs inside the existing `/api/warnings?task=expire` serverless function to stay within Vercel Hobby's function limit. It uses the production-only `CRON_SECRET` and a matching secret held in Supabase Vault; keep both server-side.
- Disciplinary records are stored in `disciplinary_subjects` and `disciplinary_actions`; RLS is enabled and browser-role access is revoked.

## Database and storage

- Public-schema tables use RLS and intentionally have no browser-facing policies. Direct `anon` and `authenticated` table access is revoked; Vercel APIs use the service role server-side.
- `site-media` is a public bucket limited to JPG, PNG, WEBP, and GIF images up to 2 MB. It contains public branding assets.
- `swat-media` is private and is intended for staff evidence and other protected media.
- `discord_announcement_sync_state`, `discord_announcement_forwards`, and `discord_announcement_forward_deliveries` provide durable forwarder cursors and delivery tracking.
- The `swat-announcement-channel-forwarder` Supabase cron job runs every minute. It requires `pg_cron`, `pg_net`, the Vercel endpoint, and `ANNOUNCEMENT_SYNC_SECRET`.

### Migrations

The first three `20261019*` files are legacy bootstrap migrations from before the current Supabase migration history was tracked. They are setup references for the initial database; **do not blindly re-run them on an existing production project**.

The later `supabase/migrations` files correspond to the tracked production migration history. Use the matching migration tooling and verify the target Supabase project before applying schema changes. Keep the version prefix in each filename aligned with the version recorded by Supabase.

## Quality checks

No third-party package installation is required for the repository checks. With Node.js 24:

```bash
node scripts/validate-source.mjs
node --test tests/*.test.mjs
```

The GitHub Actions workflow `.github/workflows/quality-checks.yml` runs these checks on pushes to `main` and pull requests.

The checks cover:
- Syntax of all API and library JavaScript modules
- Syntax of the inline portal script
- JSON validity of `vercel.json`
- Duplicate migration version prefixes
- Same-origin request allow/deny behavior

## Release checklist

1. Confirm the latest Vercel Production deployment is `READY`.
2. Confirm Discord OAuth callback, bot token, role IDs, guild ID, and channel IDs are production values.
3. Confirm the active Supabase project ID matches `SUPABASE_URL`.
4. Confirm service-role privileges and RLS posture; do not add browser policies as a shortcut.
5. Confirm the announcement cron job is active and its source channel matches the announcement room.
6. Run the repository quality checks.
7. Perform a controlled live test of login, one shared-state save, one announcement, one case notification, one standard notification, and one ordinary human-authored announcement-room forward. Verify DMs are delivered once and delivery results are logged.
8. Verify that the owner’s local browser records have been migrated to shared state before clearing browser data or switching devices.

## Operational limits

Static checks and Vercel deployment status do not replace live browser/Discord testing. Notification batches are bounded to a single serverless request; a larger recipient group needs a durable queue/worker before increasing the limit.
