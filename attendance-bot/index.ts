import { Client, GatewayIntentBits, Partials } from "discord.js";

const CHANNEL_ID = Bun.env.ATTENDANCE_CHANNEL_ID || "1569735227146768434";
const GUILD_ID = Bun.env.DISCORD_GUILD_ID;
const SWAT_ROLE_ID = Bun.env.DISCORD_ROLE_ID;
const TOKEN = Bun.env.DISCORD_BOT_TOKEN;
const SUPABASE_URL = (Bun.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_KEY = Bun.env.SUPABASE_SERVICE_ROLE_KEY;
const TIME_ZONE = "Asia/Riyadh";

function required(name: string, value?: string) {
  if (!value || !value.trim()) throw new Error("Missing required environment variable: " + name);
}
required("DISCORD_BOT_TOKEN", TOKEN);
required("DISCORD_GUILD_ID", GUILD_ID);
required("DISCORD_ROLE_ID", SWAT_ROLE_ID);
required("SUPABASE_URL", SUPABASE_URL);
required("SUPABASE_SERVICE_ROLE_KEY", SUPABASE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
});

function riyadhDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value || "";
  return get("year") + "-" + get("month") + "-" + get("day");
}

function riyadhTime(date: Date): string {
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true
  }).format(date);
}

async function recordAttendance(message: any) {
  const member = message.member;
  const author = message.author;
  if (!member || author?.bot || author?.system) return;
  if (message.guildId !== GUILD_ID || message.channelId !== CHANNEL_ID) return;

  if (!member.roles.cache.has(SWAT_ROLE_ID)) {
    await message.reply({
      content: "⚠️ تسجيل الحضور متاح لأفراد S.W.A.T المسجلين فقط.",
      allowedMentions: { repliedUser: false }
    }).catch((error: any) => {
      console.error("Could not reply to ineligible attendance message:", error?.code || error?.message);
    });
    return;
  }

  const now = new Date();
  const attendanceDate = riyadhDate(now);
  const displayName = String(member.displayName || author.username || "SWAT Member").slice(0, 100);
  const username = String(author.username || "").slice(0, 100);

  const response = await fetch(SUPABASE_URL + "/rest/v1/rpc/record_swat_daily_attendance", {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY!,
      Authorization: "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      p_discord_user_id: author.id,
      p_attendance_date: attendanceDate,
      p_message_id: message.id,
      p_channel_id: message.channelId,
      p_display_name: displayName,
      p_username: username,
      p_first_seen_at: now.toISOString()
    }),
    signal: AbortSignal.timeout(12000)
  });

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    console.error("Attendance insert failed:", response.status, detail);
    await message.reply({
      content: "⚠️ تعذّر تسجيل حضورك حاليًا. حاول مرة أخرى بعد قليل.",
      allowedMentions: { repliedUser: false }
    }).catch(() => {});
    return;
  }

  const result = await response.json() as {
    recorded?: boolean; duplicate?: boolean; eligible?: boolean; first_seen_at?: string;
  };

  if (!result.eligible) {
    await message.reply({
      content: "⚠️ لم يتم العثور على حساب SWAT نشط لك في الموقع. راجع الإدارة للتأكد من تسجيلك وتفعيل حسابك.",
      allowedMentions: { repliedUser: false }
    }).catch(() => {});
    return;
  }

  if (result.recorded) {
    await message.reply({
      content: `✅ <@${author.id}> تم تسجيل حضورك اليوم بنجاح! 🟢
وقت البصمة: **${riyadhTime(now)}** بتوقيت الرياض.`,
      allowedMentions: { users: [author.id], repliedUser: false }
    }).catch((error: any) => {
      console.error("Attendance recorded but confirmation reply failed:", error?.code || error?.message);
    });
  } else {
    await message.react("✅").catch(() => {});
    await message.reply({
      content: `✅ <@${author.id}> حضورك مسجّل بالفعل اليوم. أول بصمة كانت الساعة **${riyadhTime(new Date(result.first_seen_at || now.toISOString()))}** بتوقيت الرياض.`,
      allowedMentions: { users: [author.id], repliedUser: false }
    }).catch((error: any) => {
      console.error("Duplicate attendance reply failed:", error?.code || error?.message);
    });
  }
}

client.on("ready", () => {
  console.log("SWAT Attendance Bot online as " + client.user?.tag);
  console.log("Attendance channel: " + CHANNEL_ID);
  console.log("Timezone: " + TIME_ZONE);
});

client.on("messageCreate", async (message) => {
  if (message.channelId !== CHANNEL_ID) return;
  try {
    await recordAttendance(message);
  } catch (error: any) {
    console.error("Attendance message handler failed:", error?.message || error);
  }
});

client.on("error", (error) => console.error("Discord client error:", error.message));
process.on("unhandledRejection", (error: any) => console.error("Unhandled rejection:", error?.message || error));

await client.login(TOKEN);
