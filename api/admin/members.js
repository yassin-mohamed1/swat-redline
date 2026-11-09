import crypto from "node:crypto";
import { discordApiRequest } from "../../lib/discord-rest.js";
import { requireSameOrigin } from "../../lib/request-security.js";
import { forwardAuditToDiscord } from "../../lib/audit-log.js";
import { handleDiscordRoleSync } from "../../lib/discord-role-sync.js";
import { isWebsiteAdmin, requireActivePortalStaff } from "../../lib/portal-admin.js";
import { newlyGrantedRoles } from "../../lib/assignment-notifications.js";

const ASSIGNMENT_RANKS = [
  { key: "swatcommander", aliases: ["swatcommender"], label: "S.W.A.T COMMANDER" },
  { key: "deputyswatcommander", label: "DEPUTY S.W.A.T COMMANDER" },
  { key: "swatteamleader", label: "S.W.A.T TEAM LEADER" },
  { key: "swatsupervisor", label: "S.W.A.T SUPERVISOR" },
  { key: "swatsenioroperator", label: "S.W.A.T SENIOR OPERATOR" },
  { key: "swatoperator", label: "S.W.A.T OPERATOR" },
  { key: "swatrecruit", label: "S.W.A.T RECRUIT" }
];

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {}
  }
  return out;
}
function session(req) {
  const secret = process.env.SESSION_SECRET;
  const raw = parseCookies(req.headers.cookie || "").swat_session;
  if (!secret || !raw || !raw.includes(".")) return null;
  const i = raw.lastIndexOf("."), payload = raw.slice(0, i), sig = raw.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const received = Buffer.from(sig, "base64url");
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  let user;
  try { user = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { return null; }
  const owner = Boolean(process.env.DISCORD_OWNER_ID && user.id === process.env.DISCORD_OWNER_ID);
  if (!user.id || !user.issuedAt || Date.now() - user.issuedAt > 8 * 60 * 60 * 1000 ||
      user.issuedAt > Date.now() + 60000 || (!owner && user.roleId !== process.env.DISCORD_ROLE_ID)) return null;
  return { ...user, isOwner: owner };
}
function send(res, status, body) { return res.status(status).json(body); }
async function mergeLoginEvents(url, key, members) {
  const q = new URLSearchParams({ select: "discord_user_id,display_name,event_type,occurred_at", order: "occurred_at.desc", limit: "500" });
  try {
    const response = await supabase(url, key, "staff_login_events?" + q);
    if (!response.ok) return members;
    const events = await response.json();
    const byId = new Map(members.map((m) => [String(m.discord_user_id), m]));
    for (const event of events) {
      const id = String(event.discord_user_id || "");
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, { discord_user_id: id, display_name: event.display_name || "Discord user", username: "", avatar_url: null, is_active: true, is_banned: false, last_seen: event.occurred_at || null, last_login: event.event_type === "login" ? event.occurred_at : null, login_count: 0, _eventOnly: true });
      else {
        const m = byId.get(id);
        if (event.occurred_at && (!m.last_seen || new Date(event.occurred_at) > new Date(m.last_seen))) m.last_seen = event.occurred_at;
        if (event.event_type === "login" && event.occurred_at && (!m.last_login || new Date(event.occurred_at) > new Date(m.last_login))) m.last_login = event.occurred_at;
      }
    }
    return [...byId.values()].sort((a,b)=>new Date(b.last_seen||b.last_login||0)-new Date(a.last_seen||a.last_login||0));
  } catch { return members; }
}
async function supabase(url, key, path, init = {}) {
  return fetch(url + "/rest/v1/" + path, { ...init, headers: {
    apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json",
    ...(init.headers || {})
  }});
}
async function requireAssignmentManager(url,key,token,guildId,user) {
  if(user?.isOwner)return;
  const profileResponse=await supabase(url,key,"staff_profiles?discord_user_id=eq."+encodeURIComponent(user.id)+"&select=is_active,is_banned&limit=1");
  if(!profileResponse.ok)throw Object.assign(new Error("تعذّر التحقق من صلاحية حساب المدير."),{status:503});
  const profile=(await profileResponse.json())[0];
  if(!profile||profile.is_active===false||profile.is_banned)
    throw Object.assign(new Error("حسابك غير نشط أو غير مصرح له بإدارة التعيينات."),{status:403});
  if(user?.isWebsiteAdmin)return;
  const managerRoleId=String(process.env.DISCORD_WARNING_MANAGER_ROLE_ID||"");
  if(!/^\d{15,22}$/.test(managerRoleId))
    throw Object.assign(new Error("لم يتم إعداد رتبة إدارة التحذيرات والتعيينات في إعدادات الخادم."),{status:503});
  if(!token||!/^\d{15,22}$/.test(String(guildId||"")))
    throw Object.assign(new Error("لم يتم إعداد اتصال بوت Discord والسيرفر."),{status:503});
  const member=await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+user.id);
  if(!Array.isArray(member.roles)||!member.roles.includes(managerRoleId))
    throw Object.assign(new Error("ليس لديك رتبة إدارة التحذيرات المصرح لها بإدارة التعيينات والنداءات."),{status:403});
}
async function assignmentDiscord(token, path, init = {}) {
  try {
    return await discordApiRequest(token, path, init, {
      maxRetries: 3,
      maxRetryWaitMs: 8000
    });
  } catch (error) {
    const status = Number(error?.status || 502);
    const code = String(error?.code || status);
    const retryAfterSeconds = Number(error?.retryAfterSeconds);
    const message = status === 429
      ? "Discord تجاوز حد الطلبات المؤقت. " + (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? "يرجى الانتظار " + Math.ceil(retryAfterSeconds) + " ثانية ثم تحديث القائمة."
        : "يرجى الانتظار قليلًا ثم تحديث القائمة.")
      : "فشل طلب Discord (رمز الخطأ: " + code + ").";
    throw Object.assign(new Error(message), { status, code, path:error?.path||null, retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null });
  }
}
function assignmentRankKey(name) {
  const normalized = String(name || "").normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g,"").replace(/^\d+/,"");
  const rank = ASSIGNMENT_RANKS.find(item => item.key === normalized || (item.aliases || []).includes(normalized));
  return rank?.key || null;
}
function assignmentRankList(roles, botPosition, guildId, canManageRoles, protectedRoleIds = []) {
  const protectedIds = new Set(protectedRoleIds.map(String).filter(Boolean));
  return roles.map(role => {
    const key = assignmentRankKey(role.name);
    const def = ASSIGNMENT_RANKS.find(item => item.key === key);
    const position = Number(role.position || 0);
    const managed = Boolean(role.managed);
    const unavailableReason = protectedIds.has(String(role.id)) ? "protected"
      : String(role.id) === String(guildId) ? "everyone"
      : managed ? "managed"
      : !canManageRoles ? "permission"
      : position >= Number(botPosition) ? "hierarchy"
      : null;
    return {
      id: role.id,
      name: role.name,
      label: def?.label || role.name,
      key,
      position,
      managed,
      assignable: !unavailableReason,
      unavailable_reason: unavailableReason
    };
  }).sort((a,b)=>b.position-a.position || String(a.name).localeCompare(String(b.name)));
}
function assignmentMemberName(member, fallback = "Discord user") {
  return member?.nick || member?.user?.global_name || member?.user?.username || fallback;
}
function assignmentAvatar(member, guildId) {
  const user = member?.user || {}, id = String(user.id || "");
  const valid = value => typeof value === "string" && /^[a-zA-Z0-9_]+$/.test(value);
  if (valid(member?.avatar) && /^\d{15,22}$/.test(id)) return "https://cdn.discordapp.com/guilds/"+guildId+"/users/"+id+"/avatars/"+member.avatar+"."+(member.avatar.startsWith("a_")?"gif":"png")+"?size=128";
  if (valid(user.avatar) && /^\d{15,22}$/.test(id)) return "https://cdn.discordapp.com/avatars/"+id+"/"+user.avatar+"."+(user.avatar.startsWith("a_")?"gif":"png")+"?size=128";
  if (/^\d{15,22}$/.test(id)) return "https://cdn.discordapp.com/embed/avatars/"+Number((BigInt(id)>>22n)%6n)+".png";
  return null;
}
async function assignmentMapLimit(items, limit, worker) {
  const output = new Array(items.length); let cursor = 0;
  await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(true){const index=cursor++;if(index>=items.length)return;output[index]=await worker(items[index],index);}
  }));
  return output;
}
function assignmentPortalComponents() {
  const host=process.env.VERCEL_PROJECT_PRODUCTION_URL||process.env.SITE_URL||"swat-redline.vercel.app";
  const url=/^https?:\/\//i.test(host)?host:"https://"+host;
  return [{type:1,components:[{type:2,style:5,label:"فتح بوابة S.W.A.T. REDLINE",url}]}];
}
function assignmentEmbed({assigned,name,discordId,avatar,rankName,callsign,actor,reference}) {
  return {
    color:assigned?0xD92735:0x737B87,
    author:{name:"S.W.A.T. REDLINE • PERSONNEL COMMAND"},
    title:assigned?"🎖️ OFFICIAL APPOINTMENT":"📋 APPOINTMENT ENDED",
    description:assigned
      ?"تم اعتماد تعيينك الجديد في S.W.A.T. REDLINE من خلال بوابة القيادة."
      :"تم إنهاء تعيينك الحالي في S.W.A.T. REDLINE وإزالة رتبة التعيين من حسابك.",
    ...(avatar?{thumbnail:{url:avatar}}:{}),
    fields:[
      {name:"العضو",value:String(name||"Discord member").slice(0,180),inline:true},
      {name:"Discord ID",value:discordId,inline:true},
      {name:assigned?"الرتب الجديدة":"الرتبة",value:assigned?(String(rankName||"").trim().slice(0,100)||"لم تتم إضافة رتب جديدة في هذا التحديث."):"تم إنهاء التعيين",inline:true},
      {name:"كود النداء",value:assigned?(callsign||"لم يتم تعيين كود نداء"):"تم إلغاء كود النداء السابق",inline:true},
      {name:"صدر بواسطة",value:String(actor||"S.W.A.T. REDLINE Command").slice(0,120),inline:true},
      {name:"الرقم المرجعي",value:reference,inline:false}
    ],
    footer:{text:"S.W.A.T. REDLINE • PERSONNEL & APPOINTMENTS"},
    timestamp:new Date().toISOString()
  };
}
async function assignmentSendDm(token,targetId,embed) {
  let dm;
  try {
    dm=await assignmentDiscord(token,"/users/@me/channels",{method:"POST",body:JSON.stringify({recipient_id:targetId})});
  } catch(error) {
    error.dmStage="open_dm";
    throw error;
  }
  if(!dm?.id)throw Object.assign(new Error("تعذّر فتح محادثة خاصة مع العضو."),{dmStage:"open_dm"});
  let message;
  try {
    message=await assignmentDiscord(token,"/channels/"+dm.id+"/messages",{
      method:"POST",body:JSON.stringify({embeds:[embed],components:assignmentPortalComponents(),allowed_mentions:{parse:[]}})
    });
  } catch(error) {
    error.dmStage="send_message";
    throw error;
  }
  if(!message?.id)throw Object.assign(new Error("لم يؤكد Discord إرسال رسالة التعيين."),{dmStage:"send_message"});
  return {channelId:dm.id,messageId:message.id};
}
function assignmentDmFailureMessage(error) {
  const code=String(error?.code||"");
  if(code==="50278")return {
    ar:"تم حفظ التعيين وتحديث رتب Discord، لكن Discord رفض الرسالة الخاصة (50278) لأنه لا يرى سيرفرًا مشتركًا يسمح بمراسلة هذا العضو. راجع عضوية العضو وإعدادات الخصوصية في Discord.",
    en:"The appointment and Discord roles were saved, but Discord rejected the DM (50278) because it does not see a mutual server that allows messaging this member. Check the member's server membership and Discord privacy settings."
  };
  if(code==="50007")return {
    ar:"تم حفظ التعيين وتحديث رتب Discord، لكن Discord منع الرسالة الخاصة (50007). قد يكون العضو حاظرًا التطبيق أو لا يسمح باستقبال رسائله.",
    en:"The appointment and Discord roles were saved, but Discord blocked the DM (50007). The member may have blocked the app or disabled messages from it."
  };
  if(Number(error?.status)===429)return {
    ar:"تم حفظ التعيين وتحديث رتب Discord، لكن Discord حدّ إرسال الرسالة الخاصة مؤقتًا. يمكن إعادة المحاولة لاحقًا.",
    en:"The appointment and Discord roles were saved, but Discord temporarily rate-limited the DM. Retry the message later."
  };
  const value=code||"غير معروف";
  return {
    ar:"تم حفظ التعيين وتحديث رتب Discord، لكن تعذّر إرسال الرسالة الخاصة من Discord (رمز الخطأ: "+value+").",
    en:"The appointment and Discord roles were saved, but Discord could not deliver the DM (error code: "+(code||"unknown")+")."
  };
}
async function assignmentDeleteDm(token,dm) {
  if(dm?.channelId&&dm?.messageId)await assignmentDiscord(token,"/channels/"+dm.channelId+"/messages/"+dm.messageId,{method:"DELETE"});
}
function assignmentCallsign(value) {
  if(value==null||value==="")return null;
  const match=String(value).trim().match(/^(?:Alpha\s*)?(0|[1-9][0-9]*)$/i);
  if(!match)throw Object.assign(new Error("كود النداء يجب أن يكون Alpha متبوعًا برقم صحيح يبدأ من 0."),{status:400});
  return "Alpha "+match[1];
}
let assignmentGuildContextCache = { key: "", expiresAt: 0, value: null, pending: null };
async function assignmentGuildContext(token,guildId) {
  const cacheKey=String(guildId);
  if(assignmentGuildContextCache.key===cacheKey&&assignmentGuildContextCache.value&&assignmentGuildContextCache.expiresAt>Date.now())
    return assignmentGuildContextCache.value;
  if(assignmentGuildContextCache.key===cacheKey&&assignmentGuildContextCache.pending)
    return assignmentGuildContextCache.pending;
  const pending=(async()=>{
    const [roles,botUser]=await Promise.all([
      assignmentDiscord(token,"/guilds/"+guildId+"/roles"),
      assignmentDiscord(token,"/users/@me")
    ]);
    const botMember=await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+botUser.id);
    const byId=new Map(roles.map(role=>[role.id,role]));
    const botTop=(botMember.roles||[]).map(id=>byId.get(id)).filter(Boolean)
      .reduce((top,role)=>!top||Number(role.position)>Number(top.position)?role:top,null);
    if(!botTop)throw Object.assign(new Error("تعذّر تحديد أعلى رتبة للبوت في السيرفر."),{status:503});
    const permissions=(botMember.roles||[]).map(id=>byId.get(id)).filter(Boolean)
      .reduce((value,role)=>value|BigInt(role.permissions||"0"),0n);
    return {roles,byId,botTop,canManageRoles:(permissions&(1n<<28n))!==0n||(permissions&(1n<<3n))!==0n};
  })();
  assignmentGuildContextCache={key:cacheKey,expiresAt:0,value:null,pending};
  try {
    const value=await pending;
    assignmentGuildContextCache={key:cacheKey,expiresAt:Date.now()+30000,value,pending:null};
    return value;
  } catch(error) {
    assignmentGuildContextCache={key:"",expiresAt:0,value:null,pending:null};
    throw error;
  }
}
async function assignmentGuildMembers(token,guildId,profiles) {
  const targetIds=new Set(profiles.map(profile=>String(profile.discord_user_id)).filter(id=>/^\d{15,22}$/.test(id)));
  const found=new Map();
  if(!targetIds.size)return {found,complete:true,scannedThrough:null};
  let after=null,scannedThrough=null,complete=false,pages=0;
  while(pages<50) {
    const query=new URLSearchParams({limit:"1000"});
    if(after)query.set("after",after);
    const batch=await assignmentDiscord(token,"/guilds/"+guildId+"/members?"+query.toString());
    if(!Array.isArray(batch))throw Object.assign(new Error("أعاد Discord قائمة أعضاء غير صالحة."),{status:502});
    if(!batch.length){complete=true;break;}
    for(const member of batch) {
      const id=String(member?.user?.id||"");
      if(targetIds.has(id))found.set(id,member);
    }
    scannedThrough=String(batch[batch.length-1]?.user?.id||"");
    if(batch.length<1000){complete=true;break;}
    const pendingAboveCursor=Array.from(targetIds).some(id=>!found.has(id)&&BigInt(id)>BigInt(scannedThrough||"0"));
    if(!pendingAboveCursor)break;
    if(!/^\d{15,22}$/.test(scannedThrough))break;
    after=scannedThrough;
    pages++;
  }
  return {found,complete,scannedThrough};
}
let personnelRoleCache={key:"",expiresAt:0,value:null,pending:null};
async function cachedPersonnelDiscordRoles(token,guildId,profiles) {
  const ids=profiles.map(profile=>String(profile.discord_user_id||"")).filter(id=>/^\d{15,22}$/.test(id)).sort();
  if(!ids.length)return {found:new Map(),complete:true,scannedThrough:null};
  const cacheKey=String(guildId)+":"+ids.join(",");
  if(personnelRoleCache.key===cacheKey&&personnelRoleCache.value&&personnelRoleCache.expiresAt>Date.now())
    return personnelRoleCache.value;
  if(personnelRoleCache.key===cacheKey&&personnelRoleCache.pending)
    return personnelRoleCache.pending;
  const pending=assignmentGuildMembers(token,guildId,profiles);
  personnelRoleCache={key:cacheKey,expiresAt:0,value:null,pending};
  try{
    const value=await pending;
    personnelRoleCache={key:cacheKey,expiresAt:Date.now()+15000,value,pending:null};
    return value;
  }catch(error){
    personnelRoleCache={key:"",expiresAt:0,value:null,pending:null};
    throw error;
  }
}
async function refreshPersonnelDiscordRoles(token,guildId,members) {
  if(!Array.isArray(members)||!members.length)return {members:Array.isArray(members)?members:[],synced:true};
  if(!token||!/^\d{15,22}$/.test(String(guildId||"")))return {members,synced:false};
  try{
    const scan=await cachedPersonnelDiscordRoles(token,guildId,members);
    const membersWithLiveRoles=members.map(member=>{
      const id=String(member.discord_user_id||"");
      if(!/^\d{15,22}$/.test(id))return {...member,discord_roles_live:false};
      const live=scan.found.get(id);
      if(live)return {...member,discord_roles:Array.isArray(live.roles)?live.roles:[],discord_roles_live:true};
      const covered=scan.complete||(scan.scannedThrough&&/^\d{15,22}$/.test(String(scan.scannedThrough))&&BigInt(id)<=BigInt(scan.scannedThrough));
      return covered?{...member,discord_roles:[],discord_roles_live:true}:{...member,discord_roles_live:false};
    });
    return {members:membersWithLiveRoles,synced:true};
  }catch(error){
    console.warn("Personnel live Discord role refresh unavailable:",JSON.stringify({status:error?.status,code:error?.code}));
    return {members,synced:false};
  }
}
async function assignmentMember(token,guildId,id) {
  try {
    const member=await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+id);
    return {inGuild:true,roles:member.roles||[],name:assignmentMemberName(member),avatar:assignmentAvatar(member,guildId)};
  } catch(error) {
    if(error.status===404)return {inGuild:false,roles:[],name:null,avatar:null};
    throw error;
  }
}
async function listAssignments(url,key,token,guildId,allowWebsiteAdminRole=false) {
  if(!token||!/^\d{15,22}$/.test(String(guildId||"")))throw new Error("لم يتم إعداد اتصال بوت Discord والسيرفر.");
  const [profileResponse,assignmentResponse,callsignResponse]=await Promise.all([
    supabase(url,key,"staff_profiles?select=discord_user_id,display_name,username,avatar_url,discord_roles,discord_roles_synced_at,is_active,is_banned,is_manual,registration_source,last_login,login_count,created_at&order=display_name.asc"),
    supabase(url,key,"staff_assignments?select=discord_user_id,rank_role_id,rank_role_name,rank_role_ids,rank_role_names,callsign,status,assigned_by_name,updated_at"),
    supabase(url,key,"staff_callsigns?select=callsign&is_active=eq.true&order=callsign.asc")
  ]);
  if(!profileResponse.ok)throw new Error("تعذّر تحميل أعضاء الموقع المسجلين.");
  if(!assignmentResponse.ok)throw new Error("تعذّر تحميل سجل التعيينات.");
  if(!callsignResponse.ok)throw new Error("تعذّر تحميل قائمة أكواد النداء.");
  const profiles=await profileResponse.json(),assignments=await assignmentResponse.json(),callsignRows=await callsignResponse.json();
  const byAssignment=new Map(assignments.map(item=>[String(item.discord_user_id),item]));
  let guild=null,guildWarning="";
  try { guild=await assignmentGuildContext(token,guildId); }
  catch(error) {
    guildWarning=error?.status===429
      ?"تعذر تحديث رتب Discord اللحظية مؤقتًا بسبب حد الطلبات. تظهر بيانات آخر تسجيل دخول، وسيتم التحقق المباشر عند تنفيذ التعيين."
      :"تعذر تحديث اتصال Discord اللحظي. تظهر بيانات آخر تسجيل دخول، وسيتم التحقق المباشر عند تنفيذ التعيين.";
    console.error("Assignment guild context unavailable:",JSON.stringify({status:error?.status,code:error?.code,path:error?.path||null}));
  }
  let liveScan=null;
  if(guild) {
    try { liveScan=await assignmentGuildMembers(token,guildId,profiles); }
    catch(error) {
      guildWarning=error?.status===429
        ?"Discord حدّ مؤقتًا من تحديث قائمة الأعضاء. تظهر بيانات آخر تسجيل دخول، وسيتم التحقق المباشر عند تنفيذ التعيين."
        :error?.status===403
          ?"صلاحية قراءة قائمة أعضاء Discord غير مفعّلة للبوت. بيانات الأعضاء المسجلة ظاهرة، وسيتم التحقق المباشر عند تنفيذ التعيين."
          :"تعذر تحديث قائمة أعضاء Discord. تظهر بيانات آخر تسجيل دخول، وسيتم التحقق المباشر عند تنفيذ التعيين.";
      console.warn("Assignment bulk member sync unavailable:",JSON.stringify({status:error?.status,code:error?.code,path:error?.path||null}));
    }
  }
  const protectedRoleIds=allowWebsiteAdminRole?[]:[process.env.DISCORD_WEBSITE_ADMIN_ROLE_ID];
  const roles=guild?assignmentRankList(guild.roles,Number(guild.botTop.position),guildId,guild.canManageRoles,protectedRoleIds):[];
  const members=profiles.map(profile=>{
    const id=String(profile.discord_user_id);
    const live=liveScan?.found.get(id)||null;
    const hasSnapshot=Array.isArray(profile.discord_roles)&&Boolean(profile.discord_roles_synced_at);
    let inGuild=null,roleIds=hasSnapshot?profile.discord_roles:[],liveName=null,liveAvatar=null,roleDataSource=hasSnapshot?(profile.is_manual?"manual_snapshot":"last_login"):"unknown";
    if(live) {
      inGuild=true;roleIds=Array.isArray(live.roles)?live.roles:[];liveName=assignmentMemberName(live);liveAvatar=assignmentAvatar(live,guildId);roleDataSource="live";
    } else if(liveScan&&(liveScan.complete||(liveScan.scannedThrough&&BigInt(id)<=BigInt(liveScan.scannedThrough)))) {
      inGuild=false;roleDataSource="live";
    }
    const currentRoles=Array.isArray(roleIds)?roleIds:[];
    const currentRankRoles=roles.filter(role=>currentRoles.includes(role.id));
    const rawAssignment=byAssignment.get(id)||null;
    const assignment=rawAssignment?{...rawAssignment,rank_role_ids:Array.isArray(rawAssignment.rank_role_ids)&&rawAssignment.rank_role_ids.length?rawAssignment.rank_role_ids:(rawAssignment.rank_role_id?[rawAssignment.rank_role_id]:[]),rank_role_names:Array.isArray(rawAssignment.rank_role_names)&&rawAssignment.rank_role_names.length?rawAssignment.rank_role_names:(rawAssignment.rank_role_name?[rawAssignment.rank_role_name]:[])}:null;
    return {...profile,assignment,live_name:liveName,avatar_url:liveAvatar||profile.avatar_url||null,
      in_guild:inGuild,current_roles:currentRoles,current_rank_roles:currentRankRoles,role_data_source:roleDataSource,
      account_status:profile.is_banned?"banned":profile.is_active===false?"inactive":"active"};
  });
  const callsigns=[...new Set(callsignRows.filter(row=>row?.is_active!==false).map(row=>String(row.callsign||"")).filter(value=>/^Alpha (0|[1-9][0-9]*)$/.test(value)))].sort((a,b)=>Number(a.slice(6))-Number(b.slice(6)));
  for(const item of assignments)if(item.status==="assigned"&&item.callsign&&!callsigns.includes(item.callsign))callsigns.push(item.callsign);
  callsigns.sort((a,b)=>Number(a.slice(6))-Number(b.slice(6)));
  return {members,roles,callsigns,bot:{can_manage_roles:Boolean(guild?.canManageRoles),top_role:guild?.botTop?.name||"",top_role_position:Number(guild?.botTop?.position||0)},
    member_sync_warning:guildWarning};
}
async function handleAddManualMember(url,key,token,guildId,user,body,res) {
  if (!token || !/^\d{15,22}$/.test(String(guildId || "")))
    return send(res,503,{error:"لم يتم إعداد اتصال بوت Discord والسيرفر."});
  const targetId=String(body.discord_user_id||"").trim();
  if(!/^\d{15,22}$/.test(targetId))
    return send(res,400,{error:"أدخل Discord ID صحيحًا مكوّنًا من 15 إلى 22 رقمًا."});

  const lookup=await supabase(url,key,"staff_profiles?discord_user_id=eq."+encodeURIComponent(targetId)+"&select=discord_user_id,is_manual,display_name&limit=1");
  if(!lookup.ok)return send(res,503,{error:"تعذّر التحقق من سجل الأفراد."});
  const existing=(await lookup.json())[0];
  if(existing)return send(res,409,{error:existing.is_manual
    ?"هذا العضو مضاف بالفعل إلى دليل الأفراد."
    :"هذا العضو مسجل بالفعل في الموقع، ولا يحتاج إلى إضافة يدوية."});

  let member;
  try {
    member=await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId);
  } catch(error) {
    if(error.status===404)return send(res,404,{error:"لم يتم العثور على هذا العضو داخل سيرفر Discord. يجب أن يكون موجودًا في السيرفر أولًا."});
    if(error.status===429)return send(res,429,{error:"Discord يحدّ الطلبات مؤقتًا. انتظر قليلًا ثم أعد إضافة العضو."});
    if(error.status===403)return send(res,403,{error:"البوت لا يستطيع قراءة بيانات هذا العضو من السيرفر."});
    return send(res,error.status||502,{error:error.message||"تعذّر جلب بيانات العضو من Discord."});
  }

  const now=new Date().toISOString();
  const displayName=String(body.display_name||"").trim().slice(0,100)||assignmentMemberName(member,"Discord member");
  const avatar=assignmentAvatar(member,guildId);
  const profile={
    discord_user_id:targetId,
    display_name:displayName,
    username:String(member.user?.username||"").slice(0,100),
    avatar_url:avatar,
    is_active:true,
    is_banned:false,
    login_count:0,
    last_seen:null,
    last_login:null,
    notifications_enabled:true,
    discord_roles:Array.isArray(member.roles)?member.roles:[],
    discord_roles_synced_at:now,
    is_manual:true,
    manual_created_by_discord_id:user.id,
    registration_source:"manual_id",
    created_at:now,
    updated_at:now
  };
  const created=await supabase(url,key,"staff_profiles",{method:"POST",headers:{Prefer:"return=representation"},body:JSON.stringify(profile)});
  if(!created.ok) {
    const detail=(await created.text()).slice(0,300);
    console.error("Manual staff profile creation failed:",created.status,detail);
    if(created.status===409)return send(res,409,{error:"هذا العضو موجود بالفعل في دليل الأفراد."});
    return send(res,502,{error:"تعذّرت إضافة العضو إلى قاعدة البيانات."});
  }
  const rows=await created.json();
  if(!rows.length)return send(res,502,{error:"لم يتم تأكيد حفظ العضو في دليل الأفراد."});
  const manualAuditEvent={actor_discord_id:user.id,actor_name:user.displayName||user.username,action:"create",
    entity_type:"staff_profile",entity_id:targetId,
    details:{type:"إضافة عضو يدويًا دون تسجيل دخول للموقع",detail:"تمت إضافة "+displayName+" إلى دليل الأفراد دون تسجيل دخول.",target_name:displayName,target_discord_id:targetId}};
  try{
    const auditResponse=await supabase(url,key,"audit_logs",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify(manualAuditEvent)});
    if(auditResponse.ok)await forwardAuditToDiscord(user,manualAuditEvent);
    else console.error("Manual member audit write failed:",auditResponse.status,(await auditResponse.text()).slice(0,250));
  }catch(error){console.error("Manual member audit failed:",error?.message||"unknown");}
  return send(res,201,{ok:true,member:rows[0],message:"تمت إضافة العضو إلى الدليل دون الحاجة إلى تسجيل دخوله للموقع."});
}
async function handleAssignmentPost(url,key,token,guildId,user,body,res) {
  if (!token || !/^\d{15,22}$/.test(String(guildId || ""))) return send(res,503,{error:"لم يتم إعداد اتصال بوت Discord والسيرفر."});
  const targetId=String(body.discord_user_id||"");
  const action=body.action==="remove"?"remove":body.action==="assign"?"assign":"";
  if(!action||!/^\d{15,22}$/.test(targetId))return send(res,400,{error:"اختر عضوًا وإجراءً صحيحًا."});
  const profileResponse=await supabase(url,key,"staff_profiles?discord_user_id=eq."+encodeURIComponent(targetId)+"&select=discord_user_id,display_name,username,avatar_url,is_active,is_banned,notifications_enabled&limit=1");
  if(!profileResponse.ok)return send(res,503,{error:"تعذّر التحقق من وجود العضو في دليل الأفراد."});
  const profile=(await profileResponse.json())[0];
  if(!profile)return send(res,404,{error:"هذا العضو غير موجود في دليل الأفراد. أضفه أولًا من صفحة الأفراد."});
  if(profile.is_active===false||profile.is_banned)return send(res,409,{error:"لا يمكن تعيين حساب موقوف أو محظور من الموقع."});
  const guild=await assignmentGuildContext(token,guildId);
  if(!guild.canManageRoles)return send(res,409,{error:"البوت لا يمتلك صلاحية Manage Roles في سيرفر Discord."});
  const protectedRoleIds=user?.isOwner?[]:[process.env.DISCORD_WEBSITE_ADMIN_ROLE_ID];
  const rankRoles=assignmentRankList(guild.roles,Number(guild.botTop.position),guildId,guild.canManageRoles,protectedRoleIds);
  const requestedRoleIds=action==="assign"?(Array.isArray(body.rank_role_ids)?body.rank_role_ids.map(String):body.rank_role_id?[String(body.rank_role_id)]:[]):[];
  const websiteAdminRoleId=String(process.env.DISCORD_WEBSITE_ADMIN_ROLE_ID||"");
  if(action==="assign"&&!user?.isOwner&&websiteAdminRoleId&&requestedRoleIds.includes(websiteAdminRoleId))
    return send(res,403,{error:"Only the portal owner can grant or revoke Website Admin."});
  if(action==="assign"&&(!requestedRoleIds.length||requestedRoleIds.length>20||new Set(requestedRoleIds).size!==requestedRoleIds.length))
    return send(res,400,{error:"اختر رتبة واحدة على الأقل، وبحد أقصى 20 رتبة مختلفة."});
  const targetRoles=requestedRoleIds.map(id=>rankRoles.find(role=>role.id===id));
  if(action==="assign"&&targetRoles.some(role=>!role||!role.assignable))
    return send(res,409,{error:"إحدى الرتب المختارة غير قابلة للتعيين. راجع ترتيب رتبة البوت أو صلاحياتها."});
  const rankNames=targetRoles.map(role=>role.name);
  const callsign=action==="assign"?assignmentCallsign(body.callsign):null;
  if(action==="assign"&&callsign){
    const catalog=await supabase(url,key,"staff_callsigns?callsign=eq."+encodeURIComponent(callsign)+"&is_active=eq.true&select=callsign&limit=1");
    if(!catalog.ok)return send(res,503,{error:"تعذّر التحقق من قائمة أكواد النداء."});
    if(!(await catalog.json()).length)return send(res,409,{error:"كود النداء غير موجود في القائمة. أضفه من زر إضافة كود نداء جديد أولًا."});
  }
  const member=await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId);
  const displayName=assignmentMemberName(member,profile.display_name||"Discord member");
  const avatar=assignmentAvatar(member,guildId)||profile.avatar_url||null;
  const originalRoles=(member.roles||[]).map(String);
  // The DM must list only roles newly granted by this save, not every role
  // already present on the member or re-selected in the appointment editor.
  const newlyAssignedRoles=action==="assign"
    ?newlyGrantedRoles(targetRoles,originalRoles)
    :[];
  const reference=crypto.randomUUID();
  const embed=assignmentEmbed({
    assigned:action==="assign",
    name:displayName,
    discordId:targetId,
    avatar,
    rankName:newlyAssignedRoles.map(role=>role.name).join("، "),
    callsign,
    actor:user.displayName||user.username||"Portal manager",
    reference
  });
  const previousResponse=await supabase(url,key,"staff_assignments?discord_user_id=eq."+encodeURIComponent(targetId)+"&select=rank_role_id,rank_role_ids,status&limit=1");
  if(!previousResponse.ok)return send(res,503,{error:"تعذّر قراءة التعيين السابق قبل تحديث الرتب."});
  const previousAssignment=(await previousResponse.json())[0]||null;
  const previousRoleIds=Array.isArray(previousAssignment?.rank_role_ids)&&previousAssignment.rank_role_ids.length?previousAssignment.rank_role_ids.map(String):(previousAssignment?.rank_role_id?[String(previousAssignment.rank_role_id)]:[]);
  const replaceableRoleIds=new Set(guild.roles.filter(role=>assignmentRankKey(role.name)).map(role=>String(role.id)));
  for(const id of previousRoleIds)replaceableRoleIds.add(id);
  const rolesToReplace=guild.roles.filter(role=>replaceableRoleIds.has(String(role.id))&&originalRoles.includes(String(role.id)));
  const blocking=rolesToReplace.find(role=>!rankRoles.find(item=>item.id===role.id)?.assignable);
  if(blocking)return send(res,409,{error:"لا يستطيع البوت إزالة رتبة التعيين الحالية «"+blocking.name+"». ارفع رتبة البوت فوقها أولًا أو أزلها يدويًا."});
  const next=new Set(originalRoles);
  for(const role of rolesToReplace)next.delete(String(role.id));
  for(const role of targetRoles)next.add(role.id);
  const desiredRoles=[...next],roleChanged=originalRoles.join(",")!==desiredRoles.join(",");
  if(roleChanged)await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId,{method:"PATCH",body:JSON.stringify({roles:desiredRoles})});

  // Persist the appointment before attempting a DM. A recipient's privacy settings
  // must never undo a valid role change or leave Discord and the portal out of sync.
  let savedResult;
  try{
    let saved;
    try{
      saved=await supabase(url,key,"rpc/save_staff_assignment_v2",{method:"POST",body:JSON.stringify({
        p_discord_user_id:targetId,p_display_name:displayName,p_username:member.user?.username||profile.username||"",
        p_avatar_url:avatar||"", 
        p_rank_role_ids:action==="assign"?requestedRoleIds:[],p_rank_role_names:action==="assign"?rankNames:[],
        p_callsign:callsign,p_status:action==="assign"?"assigned":"unassigned",
        p_actor_discord_id:user.id,p_actor_name:user.displayName||user.username||"Portal manager"
      })});
    }catch(fetchError){
      throw Object.assign(new Error("تعذّر الاتصال بطلب حفظ التعيين في Supabase: "+String(fetchError?.message||fetchError)),{
        code:"assignment_rpc_network_error",stage:"rpc_request"
      });
    }
    if(!saved.ok){
      const raw=await saved.text();
      let detail={};
      try{detail=raw?JSON.parse(raw):{};}catch{detail={message:raw};}
      const diagnostic={
        status:Number(saved.status||0),
        code:String(detail.code||detail.error||"supabase_http_"+saved.status),
        message:String(detail.message||detail.details||detail.hint||"Supabase rejected the assignment save.").slice(0,240)
      };
      console.error("Assignment database RPC rejected:",JSON.stringify(diagnostic));
      throw Object.assign(new Error(diagnostic.message),{
        code:diagnostic.code,status:diagnostic.status,stage:"rpc_response",diagnostic
      });
    }
    let payload;
    try{payload=await saved.json();}catch(parseError){
      throw Object.assign(new Error("استلم الموقع ردًا غير مفهوم من قاعدة البيانات."),{
        code:"assignment_rpc_invalid_json",stage:"rpc_parse"
      });
    }
    const rpcResult=Array.isArray(payload)?(payload[0]?.save_staff_assignment_v2||payload[0]):(payload?.save_staff_assignment_v2||payload);
    savedResult=rpcResult?.after||null;
    if(!savedResult){
      // Confirm persistence in case the RPC response was wrapped by the REST gateway.
      const verify=await supabase(url,key,"staff_assignments?discord_user_id=eq."+encodeURIComponent(targetId)+
        "&select=discord_user_id,display_name,rank_role_id,rank_role_name,rank_role_ids,rank_role_names,callsign,status&limit=1");
      if(verify.ok){
        const rows=await verify.json();
        const row=Array.isArray(rows)?rows[0]:null;
        const expectedStatus=action==="assign"?"assigned":"unassigned";
        const sameStatus=row?.status===expectedStatus;
        const sameRoles=action==="remove"||
          (Array.isArray(row?.rank_role_ids)&&row.rank_role_ids.length===requestedRoleIds.length&&
           requestedRoleIds.every(id=>row.rank_role_ids.includes(id)));
        const sameCallsign=action==="remove"||row?.callsign===(callsign||null);
        if(row&&sameStatus&&sameRoles&&sameCallsign)savedResult=row;
      }
    }
    if(!savedResult)throw Object.assign(new Error("قاعدة البيانات لم تؤكد حفظ التعيين. راجع كود التشخيص قبل إعادة المحاولة."),{
      code:"assignment_database_confirmation_missing",stage:"rpc_confirmation"
    });
  }catch(error){
    let rollbackFailed=false;
    if(roleChanged)try{await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId,{method:"PATCH",body:JSON.stringify({roles:originalRoles})});}
    catch(rollback){rollbackFailed=true;console.error("Assignment rollback after database failure:",rollback.code||rollback.message);}
    const diagnostic={
      code:String(error?.code||"assignment_database_write_failed"),
      status:Number(error?.status||0)||null,
      stage:String(error?.stage||"rpc_unknown"),
      message:String(error?.message||"Unknown database error").slice(0,240)
    };
    console.error("Assignment database save failed:",JSON.stringify({...diagnostic,rollback_failed:rollbackFailed}));
    const errorText=rollbackFailed
      ?"فشل حفظ التعيين وفشل التراجع عن رتب Discord. يلزم مراجعة العضو يدويًا."
      :"تعذّر حفظ سجل التعيين؛ تم التراجع عن تغيير رتب Discord.";
    return send(res,502,{
      error:errorText,rollback_failed:rollbackFailed,
      database_diagnostic:diagnostic
    });
  }

  try{
    await forwardAuditToDiscord(user,{action:action==="remove"?"delete":previousAssignment?"update":"create",
      entity_type:"staff_assignment",entity_id:targetId,
      details:{type:action==="remove"?"إنهاء تعيين فرد":previousAssignment?"تعديل تعيين فرد":"تعيين فرد",
        detail:action==="remove"?"تم إنهاء تعيين "+displayName:"تم تعيين "+displayName+" بالرتب "+rankNames.join("، ")+(callsign?" • "+callsign:""),
        target_discord_id:targetId}});
  }catch(auditError){
    console.error("Assignment audit forward failed:",auditError?.code||auditError?.message||"unknown");
  }

  const dmAllowed=profile.notifications_enabled!==false;
  let dmStatus=dmAllowed?"sent":"skipped",dmFailure=null;
  if(dmAllowed){
    try{
      await assignmentSendDm(token,targetId,embed);
    }catch(error){
      dmStatus="failed";
      const messages=assignmentDmFailureMessage(error);
      dmFailure={
        code:String(error?.code||error?.status||"unknown"),
        stage:error?.dmStage||"unknown",
        message:messages.ar,
        message_en:messages.en
      };
      console.warn("Assignment DM delivery failed:",JSON.stringify({code:dmFailure.code,stage:dmFailure.stage,status:Number(error?.status||0)}));
    }
  }else{
    console.info("Assignment DM skipped because the member disabled private notifications.");
  }
  return send(res,200,{
    ok:true,action,assignment:savedResult,dm_status:dmStatus,
    ...(dmStatus==="skipped"?{dm_skipped_reason:"recipient_opted_out"}:{}),
    ...(dmFailure?{dm_error_code:dmFailure.code,dm_error_stage:dmFailure.stage,dm_message:dmFailure.message,dm_message_en:dmFailure.message_en}:{}),
    reference
  });
}

async function handleAddNextCallsign(url,key,user,res){
  const [catalogResponse,assignmentResponse]=await Promise.all([
    supabase(url,key,"staff_callsigns?select=callsign,is_active"),
    supabase(url,key,"staff_assignments?select=callsign&status=eq.assigned&callsign=not.is.null")
  ]);
  if(!catalogResponse.ok||!assignmentResponse.ok)return send(res,503,{error:"تعذّر قراءة أكواد النداء الحالية."});
  const catalog=await catalogResponse.json(),assignments=await assignmentResponse.json(),used=new Set();
  for(const row of [...catalog,...assignments]){
    const match=String(row?.callsign||"").match(/^Alpha (0|[1-9][0-9]*)$/);
    if(match)used.add(Number(match[1]));
  }
  const number=used.size?Math.max(...used)+1:0,callsign="Alpha "+number;
  const response=await supabase(url,key,"staff_callsigns",{method:"POST",headers:{Prefer:"return=representation"},
    body:JSON.stringify({callsign,created_by_discord_id:user.id})});
  if(!response.ok){
    const detail=(await response.text()).slice(0,300);
    return send(res,response.status===409?409:502,{error:response.status===409?"تم إنشاء كود نداء آخر في نفس اللحظة. حدّث القائمة ثم حاول مرة أخرى.":"تعذّر حفظ كود النداء الجديد.",detail:response.status===409?undefined:detail});
  }
  const auditEvent={actor_discord_id:user.id,actor_name:user.displayName||user.username,action:"create",entity_type:"staff_callsign",entity_id:callsign,
    details:{type:"إضافة كود نداء جديد",detail:"تمت إضافة "+callsign+" إلى قائمة أكواد النداء.",callsign}};
  const audit=await supabase(url,key,"audit_logs",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify(auditEvent)});
  if(audit.ok)await forwardAuditToDiscord(user,auditEvent);
  else console.error("Callsign audit write failed:",audit.status,(await audit.text()).slice(0,250));
  return send(res,201,{ok:true,callsign});
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = session(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return send(res, 503, { error: "Database is not configured" });
  let websiteAdmin = false;
  try {
    websiteAdmin = await isWebsiteAdmin(user);
    if (websiteAdmin && !user.isOwner) await requireActivePortalStaff(user);
  } catch (error) {
    return send(res, error.status || 503, { error: error.message || "تعذر التحقق من صلاحيات إدارة الموقع." });
  }
  user.isWebsiteAdmin = websiteAdmin;
  const canManagePortal = Boolean(user.isOwner || websiteAdmin);
  if (!canManagePortal) return send(res,403,{error:"Website Admin permission required"});
  try {
    const searchParams = new URL(req.url, "https://portal.invalid").searchParams;
    const requestBody = req.body && typeof req.body === "object" ? req.body : {};
    if (req.method === "POST" && [
      "list_discord_role_candidates",
      "register_selected_discord_members"
    ].includes(String(requestBody.action || ""))) {
      if (!canManagePortal) return send(res,403,{error:"Website Admin permission required"});
      if (!requireSameOrigin(req,res)) return;
      return await handleDiscordRoleSync(req,res);
    }
    if(req.method==="PATCH"&&!canManagePortal)return send(res,403,{error:"Website Admin permission required"});
    if(req.method==="GET"&&searchParams.get("activity")==="1"&&!canManagePortal)return send(res,403,{error:"Website Admin permission required"});
    const needsAssignmentManager=req.method==="POST"||(req.method==="GET"&&searchParams.get("activity")!=="1");
    if(needsAssignmentManager){
      try{await requireAssignmentManager(url,key,process.env.DISCORD_BOT_TOKEN,process.env.DISCORD_GUILD_ID,user);}
      catch(error){return send(res,error.status||403,{error:error.message||"ليس لديك صلاحية إدارة الأفراد والتعيينات."});}
    }
    if (req.method === "GET" && searchParams.get("assignments") === "1") {
      const token = process.env.DISCORD_BOT_TOKEN, guildId = process.env.DISCORD_GUILD_ID;
      try { return send(res, 200, await listAssignments(url,key,token,guildId,user.isOwner)); }
      catch (error) { console.error("Assignment list failed:",error?.message||"unknown"); return send(res,error.status||502,{error:error.message||"Could not load assignments."}); }
    }
    if (req.method === "GET" && new URL(req.url, "https://portal.invalid").searchParams.get("activity") === "1") {
      const query = new URLSearchParams({
        select: "id,discord_user_id,display_name,event_type,session_issued_at,occurred_at",
        order: "occurred_at.desc",
        limit: "100"
      });
      const response = await supabase(url, key, "staff_login_events?" + query.toString());
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        console.error("Staff activity read failed:", response.status, detail);
        return send(res, 502, { error: "Could not load login activity.", diagnostics: {
          status: response.status, databaseError: detail,
          hint: "Verify public.staff_login_events exists in the same Supabase project as SUPABASE_URL."
        }});
      }
      return send(res, 200, { events: await response.json() });
    }
    if (req.method === "GET") {
      const q = new URLSearchParams({
        select: "discord_user_id,display_name,username,avatar_url,discord_roles,is_active,is_banned,is_manual,registration_source,last_seen,last_login,login_count,created_at,updated_at",
        order: "last_seen.desc.nullslast"
      });
      const response = await supabase(url, key, "staff_profiles?" + q);
      if (response.ok) {
        const members = await response.json();
        const normalized = members.map((m) => ({ ...m, is_active: m.is_active !== false, is_banned: Boolean(m.is_banned), last_seen: m.last_seen || null, last_login: m.last_login || null, login_count: Number(m.login_count || 0) }));
        const merged=await mergeLoginEvents(url,key,normalized);
        const liveRoles=await refreshPersonnelDiscordRoles(process.env.DISCORD_BOT_TOKEN,process.env.DISCORD_GUILD_ID,merged);
        return send(res, 200, { members: liveRoles.members, ownerId: process.env.DISCORD_OWNER_ID, websiteAdminRoleId: process.env.DISCORD_WEBSITE_ADMIN_ROLE_ID || "", memberRolesLive: liveRoles.synced, migrationRequired: false });
      }

      const detail = (await response.text()).slice(0, 500);
      console.error("Admin members read failed:", response.status, detail);

      // Backward-compatible fallback: allow the personnel directory to load
      // even before the activity-tracking migration has been applied.
      const fallbackQuery = new URLSearchParams({
        select: "discord_user_id,display_name,username,avatar_url,is_active,is_manual,created_at,updated_at",
        order: "updated_at.desc",
      });
      const fallback = await supabase(url, key, "staff_profiles?" + fallbackQuery);
      if (!fallback.ok) {
        const fallbackDetail = (await fallback.text()).slice(0, 500);
        console.error("Admin members fallback failed:", fallback.status, fallbackDetail);
        return send(res, 502, {
          error: "The personnel table could not be read.",
          code: "STAFF_PROFILES_UNAVAILABLE",
          diagnostics: {
            primaryStatus: response.status,
            primaryError: detail,
            fallbackStatus: fallback.status,
            fallbackError: fallbackDetail,
            hint: "Check the deployed SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, then verify public.staff_profiles exists in the same Supabase project."
          }
        });
      }
      const members = (await fallback.json()).map((m) => ({
        ...m,
        is_banned: false,
        last_seen: null,
        last_login: null,
        login_count: 0,
      }));
      const liveRoles=await refreshPersonnelDiscordRoles(process.env.DISCORD_BOT_TOKEN,process.env.DISCORD_GUILD_ID,members);
      return send(res, 200, {
        members: liveRoles.members,
        ownerId: process.env.DISCORD_OWNER_ID,
        websiteAdminRoleId: process.env.DISCORD_WEBSITE_ADMIN_ROLE_ID || "",
        memberRolesLive: liveRoles.synced,
        migrationRequired: true,
        warning: "Directory loaded without activity tracking. Apply the admin controls migration to enable login counts, last activity, bans, and site settings.",
      });
    }
    if (req.method === "POST") {
      if (!requireSameOrigin(req,res)) return;
      const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
      if(body.action==="add_manual_member")
        return await handleAddManualMember(url,key,process.env.DISCORD_BOT_TOKEN,process.env.DISCORD_GUILD_ID,user,body,res);
      if(body.action==="add_next_callsign")
        return await handleAddNextCallsign(url,key,user,res);
      return await handleAssignmentPost(url,key,process.env.DISCORD_BOT_TOKEN,process.env.DISCORD_GUILD_ID,user,body,res);
    }
    if (req.method !== "PATCH") {
      res.setHeader("Allow", "GET, POST, PATCH");
      return send(res, 405, { error: "Method not allowed" });
    }
    if (!requireSameOrigin(req, res)) return;
    const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
    const targetId = String(body.discord_user_id || "");
    const action = String(body.action || "");
    if (!/^\d{15,22}$/.test(targetId) || !["ban", "unban", "deactivate", "activate", "delete"].includes(action))
      return send(res, 400, { error: "Invalid member action" });
    if (targetId === process.env.DISCORD_OWNER_ID)
      return send(res, 403, { error: "The protected owner cannot be modified." });

    if (action === "delete") {
      const actorName = user.displayName || user.username || "Portal owner";
      const deleted = await supabase(url,key,"rpc/forget_staff_member_data",{
        method:"POST",
        body:JSON.stringify({p_discord_user_id:targetId,p_actor_discord_id:user.id,p_actor_name:actorName})
      });
      if(!deleted.ok) {
        console.error("Permanent member deletion failed:",deleted.status,(await deleted.text()).slice(0,500));
        return send(res,502,{error:"تعذّر حذف بيانات العضو بالكامل. لم يتم تأكيد اكتمال العملية."});
      }
      const result=await deleted.json().catch(()=>null);
      if(!result?.ok||!result?.deleted)
        return send(res,502,{error:"لم تؤكد قاعدة البيانات اكتمال حذف العضو."});
      try {
        await forwardAuditToDiscord(user,{action:"delete",entity_type:"staff_profile",entity_id:null,
          details:{type:"حذف نهائي لبيانات عضو",detail:"تم حذف بيانات عضو نهائيًا من بوابة S.W.A.T. REDLINE."}});
      } catch(error) {
        console.error("Permanent member deletion audit forwarding failed:",error?.message||"unknown");
      }
      return send(res,200,{ok:true,deleted:true,counts:result.counts||{}});
    }
    const values = action === "ban" ? { is_banned: true, is_active: false }
      : action === "unban" ? { is_banned: false, is_active: true }
      : action === "deactivate" ? { is_active: false }
      : { is_active: true, is_banned: false };
    values.updated_at = new Date().toISOString();
    const q = new URLSearchParams({ discord_user_id: "eq." + targetId });
    const response = await supabase(url, key, "staff_profiles?" + q, {
      method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify(values)
    });
    if (!response.ok) {
      console.error("Admin member update failed:", response.status, (await response.text()).slice(0, 500));
      return send(res, 502, { error: "Could not update this member." });
    }
    let rows = await response.json();
    if (!rows.length) {
      // A person may exist in the login-event stream before their profile row exists.
      const eventQuery = new URLSearchParams({ discord_user_id: "eq." + targetId, select: "display_name,occurred_at", order: "occurred_at.desc", limit: "1" });
      const eventResponse = await supabase(url, key, "staff_login_events?" + eventQuery);
      const events = eventResponse.ok ? await eventResponse.json() : [];
      if (!events.length) return send(res, 404, { error: "No login record found for this member." });
      const event = events[0], now = new Date().toISOString();
      const created = await supabase(url, key, "staff_profiles", {
        method: "POST", headers: { Prefer: "return=representation" },
        body: JSON.stringify({ discord_user_id: targetId, display_name: event.display_name || "Discord user", username: "", avatar_url: null, is_active: values.is_active ?? true, is_banned: values.is_banned ?? false, login_count: 0, last_seen: event.occurred_at || now, last_login: event.occurred_at || now, created_at: now, updated_at: now })
      });
      if (!created.ok) {
        console.error("Admin member profile creation failed:", created.status, (await created.text()).slice(0, 400));
        return send(res, 502, { error: "Could not create the staff profile for this member. Check the staff_profiles database schema." });
      }
      rows = await created.json();
      if (!rows.length) return send(res, 502, { error: "The staff profile was not returned after creation." });
    }
    const memberAuditEvent={actor_discord_id:user.id,actor_name:user.displayName||user.username,action:"permission_change",
      entity_type:"staff_profile",entity_id:targetId,
      details:{type:"تغيير صلاحية فرد",detail:"تم تنفيذ "+action+" على "+(rows[0].display_name||targetId),change:action,target_name:rows[0].display_name||targetId}};
    try{
      const auditResponse=await supabase(url,key,"audit_logs",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify(memberAuditEvent)});
      if(auditResponse.ok)await forwardAuditToDiscord(user,memberAuditEvent);
      else console.error("Staff permission audit failed:",auditResponse.status,(await auditResponse.text()).slice(0,250));
    }catch(error){console.error("Staff permission audit failed:",error?.message||"unknown");}
    return send(res,200,{ok:true,member:rows[0]});
  } catch (e) {
    console.error("Admin members API failed:", e?.message || "unknown");
    return send(res, 500, { error: "Personnel service failed." });
  }
}