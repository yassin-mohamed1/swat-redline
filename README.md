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
- Only an active owner or Website Admin (through the existing `requireManager` gate) can adjust, edit, or void warning records. No ordinary member-facing permission was added.
- Managers can edit a completed warning's display name, warning level, reason, and details. If it is the active/latest warning, its Discord warning role and expiry are synchronized; edits still work when an old Discord message was manually deleted.
- Voiding a warning marks the action `voided` instead of hard-deleting it, records the reason and administrator, and recalculates the member's state from the latest remaining completed action. If the voided warning was current, the matching Discord warning role is synchronized.
- A void action attempts to remove the old warning-channel post and member DM; already-deleted messages are treated as removed. Failed Discord cleanup or role sync is surfaced to the administrator without erasing the audit trail.
- `voided` actions remain visible in the history filter with their void reason and the person who voided them. Database RPCs are executable only by `service_role`; API access is protected by the same server-side owner/Website Admin gate as the rest of the Warnings page.

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


## SWAT Daily Attendance

- The attendance sync runs as a Vercel API route called by a Supabase `pg_cron` job every 5 seconds. No always-on Railway worker is required.
- The route is authenticated with the existing `ANNOUNCEMENT_SYNC_SECRET` and uses the existing Discord bot and Supabase service-role environment variables in Vercel.
- It polls only attendance channel `1569735227146768434`, reads message author and timestamp metadata, and does not need message text.
- Only non-bot members in the configured guild who hold `DISCORD_ROLE_ID` and have an active, non-banned `staff_profiles` record can be recorded.
- The first message per member per Riyadh calendar day is stored in `attendance_records`; additional messages receive an already-recorded confirmation. The unique `(discord_user_id, attendance_date)` constraint makes this idempotent.
- A unique lease token protects each poller run. The lease is renewed every 5 seconds, expires after 18 seconds without a successful heartbeat, and prevents stale runs from releasing a newer lock or advancing its cursor.
- Each run processes at most 5 messages, uses bounded Discord/Supabase request timeouts, and leaves unprocessed messages for the next poll.
- The scheduler uses a database cursor so overlapping runs do not double-process messages. On its first run it records the latest existing message as a baseline; only later messages are treated as new attendance.
- Attendance warnings, dismissals, role changes, and automatic removals are intentionally not part of this phase.
- Apply `20261110165500_schedule_swat_attendance_poller.sql` only after `/api/notifications/send?task=attendance` is deployed to production.
- Apply `20261111034000_swat_attendance_lease_recovery.sql` before deploying the version of `lib/attendance-poller.js` that uses the versioned lease RPCs.

## S.W.A.T. Attention Alert

- The portal remains on Vercel. `bot/` contains a separate, always-on Node.js 22+ Discord Gateway worker using discord.js 14.28.1; the Vercel serverless runtime does not host the persistent Gateway connection.
- The worker registers one guild User Context Menu command named **S.W.A.T. Attention Alert** by upserting that command only. It does not bulk-replace other application commands.
- The worker listens for `GUILD_VOICE_STATES` and checks `selfDeaf`. For each alert it automatically selects the least occupied existing standard voice channel that the bot can access, excluding the member's original channel and the server AFK channel. It then moves the member to that room and back, one confirmed move at a time; no dedicated channel setting is required. It never changes self-deafen, server-deafen, mute, or microphone state.
- The Discord command is limited to members with `Move Members` and `DISCORD_WARNING_MANAGER_ROLE_ID`. Before starting and each move, the bot checks its own `View Channel`, `Connect`, and `Move Members` permissions in the original and selected destination channel. The site stop action is restricted server-side to the protected owner or Website Admin.
- Active rows and stop requests use the service-only `attention_alerts` table. Apply `20261119164853_attention_alerts.sql` to the same Supabase project before starting the worker. RLS is enabled, browser roles have no table privileges, and a partial unique index prevents two active alerts for one member. A database lease prevents overlapping worker instances.
- The worker must have these existing server-side settings: `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_WARNING_MANAGER_ROLE_ID`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`. No dedicated attention channel ID is required. Never put the bot token or service-role key in browser code or repository files.
- Optional private voice-entry notification: set `DISCORD_VOICE_ALERT_OWNER_ID` to the Discord user who should receive the DM and `DISCORD_VOICE_ALERT_TARGET_ID` to the member who has agreed to the notification. The worker sends a DM only when that member joins or switches to a voice channel; it does not post to a server channel or create a separate voice-alert record. The existing staff attendance recorder remains unchanged and may continue to record eligible staff voice attendance. These values belong in the worker's environment, never in committed source.
- The timing settings are centralized in `bot/config.mjs`: `ATTENTION_ALERT_CYCLE_MS` defaults to 5000, `ATTENTION_ALERT_DWELL_MS` to 0, and `ATTENTION_ALERT_MAX_DURATION_MS` is disabled by default (0) so the alert continues until the member self-undeafens or a moderator stops it. Set a positive maximum between 10 seconds and 15 minutes only if the server explicitly wants an automatic timeout. `ATTENTION_ALERT_COOLDOWN_MS` defaults to 60000, `ATTENTION_ALERT_STOP_POLL_MS` to 1000, and `ATTENTION_ALERT_MOVE_TIMEOUT_MS` to 8000. Timing bounds are validated during worker startup.
- To host the worker, deploy the `bot/` directory as a long-running Node service with `npm start` and keep one service replica. Use a provider that supports a persistent WebSocket/Gateway process. The site continues to deploy from the repository's existing Vercel Git connection. Deploy the site change first, apply the migration, configure the worker environment, then start the worker so it registers the command.
- A worker restart marks old `active` rows as `interrupted`, clears them from the active dashboard, and does not resume or force-move members. If the process stops during the brief channel transition, check the member's current channel and move them manually if needed.
- Run `node --test bot/*.test.mjs` and the repository quality checks before release. These tests exercise mocked Discord state; a controlled Discord test guild is still required to verify actual role/channel permissions and live move delivery.


## Leave Requests and Early Leave Cutoff

- Staff submit a Discord leave request using the persistent green **طلب إجازة** button in `LEAVE_REQUEST_CHANNEL_ID`. The button opens a modal for the member's in-city military name, reason, and requested duration in days.
- The bot validates an active staff portal profile and a current S.W.A.T. Discord role, accepts Arabic/Persian or English digits for the duration, and prevents a second pending request for the same member. Each modal interaction is stored idempotently in `attendance_leave_requests`.
- Discord submissions use `source='discord'`, keep the requested duration separately from the approved dates, and remain `pending` until a Website Admin reviews them. The admin leave table shows the military name, reason, requested duration, and source. The approval dialog pre-fills the requested duration but allows the reviewer to change the start date and final duration.
- The legacy free-text Discord intake is disabled. New messages in the leave room are directed to the green button; the existing poller remains active for channel cleanup.
- The same website leave request ledger, review permissions, approval/rejection DMs, approved-leave attendance exemptions, and early-cutoff/audit behavior remain in use. The separate website leave form remains available.
- Required Railway worker setting: `LEAVE_REQUEST_CHANNEL_ID`. The value must be the existing Discord leave room ID and must match the Vercel `LEAVE_REQUEST_CHANNEL_ID` used by the old cleanup poller.
- Apply the migration `20261120130000_discord_leave_request_modal_fields.sql` to the same Supabase project before deploying the updated Railway worker and Vercel portal.


- Staff can submit a leave request from the standalone **الإجازات** portal page and see only their own requests and decisions.
- Only Website Admins (and the protected owner, following the existing admin access rule) can open the full request list, approve or reject requests, or cancel or end an approved leave.
- An early cutoff preserves the original approved end date and records the cutoff date, admin, reason, Discord DM delivery state, and audit entry. The employee receives a Discord DM with the cancellation or last covered day.
- Apply `20261116201934_attendance_leave_cutoff.sql` and `20261116203534_attendance_leave_cutoff_is_exclusive.sql` in order before deploying the API. The second migration makes the cutoff date the first day not counted as leave and materializes already-recorded same-day cancellations.


## Welcome image cards

- The **الترحيب والمغادرة** page uses the supplied Redline S.W.A.T. operator banner as its default template. The blank preview asset is `redline-operator-template.png`, and the bot includes its own copy at `bot/welcome-template.png`; both retain the red portrait ring and uniform artwork while clearing the original portrait and name plaque.
- For each new member, the bot generates a 1200×675 PNG with their Discord avatar clipped into the red ring and their display name written directly on the uniform. The editor supports dragging both overlays in the preview and adjusting horizontal/vertical position, avatar size, name size, name width, name color, and font. A custom HTTPS background URL remains available.
- The bot automatically mentions the new member above the image. The optional extra message can stay empty to send only the mention and image, or add a greeting alongside it. The goodbye message remains text-based.
- Settings are stored in the existing `app_state` row named `swat-bot-control`; no database migration is needed. The bot refreshes these settings every 15 seconds.
- The bot requests Discord's privileged **Guild Members** Gateway intent to receive join and leave events. Enable that intent in the Discord Developer Portal before deploying the updated bot, and make sure the bot can view and send messages in the selected channels.
- Custom background images must use HTTPS and a public host. The renderer accepts PNG, JPEG, WebP, GIF, or AVIF images up to 6 MB. If a custom background cannot be loaded, the configured solid color is used instead.
- The bot container installs Noto fonts for Arabic names and text. The PNG renderer uses `sharp`; `bot/package-lock.json` pins the dependency for reproducible installs.
