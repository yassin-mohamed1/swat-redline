import crypto from "node:crypto";
import { discordApiRequest } from "../../lib/discord-rest.js";
import { requireSameOrigin } from "../../lib/request-security.js";

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
  const managerRoleId=String(process.env.DISCORD_WARNING_MANAGER_ROLE_ID||"");
  if(!/^\\d{15,22}$/.test(managerRoleId))
    throw Object.assign(new Error("لم يتم إعداد رتبة إدارة التحذيرات والتعيينات في إعدادات الخادم."),{status:503});
  if(!token||!/^\\d{15,22}$/.test(String(guildId||"")))
    throw Object.assign(new Error("لم يتم إعداد اتصال بوت Discord والسيرفر."),{status:503});
  const profileResponse=await supabase(url,key,"staff_profiles?discord_user_id=eq."+encodeURIComponent(user.id)+"&select=is_active,is_banned&limit=1");
  if(!profileResponse.ok)throw Object.assign(new Error("تعذّر التحقق من صلاحية حساب المدير."),{status:503});
  const profile=(await profileResponse.json())[0];
  if(!profile||profile.is_active===false||profile.is_banned)
    throw Object.assign(new Error("حسابك غير نشط أو غير مصرح له بإدارة التعيينات."),{status:403});
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
function assignmentRankList(roles, botPosition, guildId, canManageRoles) {
  return roles.map(role => {
    const key = assignmentRankKey(role.name);
    const def = ASSIGNMENT_RANKS.find(item => item.key === key);
    const position = Number(role.position || 0);
    const managed = Boolean(role.managed);
    const unavailableReason = String(role.id) === String(guildId) ? "everyone"
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
      {name:"الرتبة",value:assigned?String(rankName).slice(0,100):"تم إنهاء التعيين",inline:true},
      {name:"كود النداء",value:assigned?(callsign||"لم يتم تعيين كود نداء"):"تم إلغاء كود النداء السابق",inline:true},
      {name:"صدر بواسطة",value:String(actor||"S.W.A.T. REDLINE Command").slice(0,120),inline:true},
      {name:"الرقم المرجعي",value:reference,inline:false}
    ],
    footer:{text:"S.W.A.T. REDLINE • PERSONNEL & APPOINTMENTS"},
    timestamp:new Date().toISOString()
  };
}
async function assignmentSendDm(token,targetId,embed) {
  const dm=await assignmentDiscord(token,"/users/@me/channels",{method:"POST",body:JSON.stringify({recipient_id:targetId})});
  if(!dm?.id)throw new Error("تعذّر فتح محادثة خاصة مع العضو.");
  const message=await assignmentDiscord(token,"/channels/"+dm.id+"/messages",{
    method:"POST",body:JSON.stringify({embeds:[embed],components:assignmentPortalComponents(),allowed_mentions:{parse:[]}})
  });
  if(!message?.id)throw new Error("لم يؤكد Discord إرسال رسالة التعيين.");
  return {channelId:dm.id,messageId:message.id};
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
async function assignmentMember(token,guildId,id) {
  try {
    const member=await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+id);
    return {inGuild:true,roles:member.roles||[],name:assignmentMemberName(member),avatar:assignmentAvatar(member,guildId)};
  } catch(error) {
    if(error.status===404)return {inGuild:false,roles:[],name:null,avatar:null};
    throw error;
  }
}
async function listAssignments(url,key,token,guildId) {
  if(!token||!/^\d{15,22}$/.test(String(guildId||"")))throw new Error("لم يتم إعداد اتصال بوت Discord والسيرفر.");
  const [profileResponse,assignmentResponse,callsignResponse]=await Promise.all([
    supabase(url,key,"staff_profiles?select=discord_user_id,display_name,username,avatar_url,discord_roles,discord_roles_synced_at,is_active,is_banned,is_manual,created_at&order=display_name.asc"),
    supabase(url,key,"staff_assignments?select=discord_user_id,rank_role_id,rank_role_name,rank_role_ids,rank_role_names,callsign,status,assigned_by_name,updated_at"),
    supabase(url,key,"staff_callsigns?select=callsign&is_active=eq.true&order=callsign.asc")
  ]);
  if(!profileResponse.ok)throw new Error("تعذّر تحميل أعضاء الموقع المسجلين.");
  if(!assignmentResponse.ok)throw new Error("تعذّر تحميل سجل التعيينات.");
  const profiles=await profileResponse.json(),assignments=await assignmentResponse.json();
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
  const roles=guild?assignmentRankList(guild.roles,Number(guild.botTop.position),guildId,guild.canManageRoles):[];
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
  try {
    await supabase(url,key,"audit_logs",{method:"POST",headers:{Prefer:"return=minimal"},body:JSON.stringify({
      actor_discord_id:user.id,
      actor_name:user.displayName||user.username,
      action:"create",
      entity_type:"staff_profile",
      entity_id:targetId,
      details:{type:"إضافة عضو يدويًا دون تسجيل دخول للموقع",target_name:displayName,target_discord_id:targetId}
    })});
  } catch {}
  return send(res,201,{ok:true,member:rows[0],message:"تمت إضافة العضو إلى الدليل دون الحاجة إلى تسجيل دخوله للموقع."});
}
async function handleAssignmentPost(url,key,token,guildId,user,body,res) {
  if (!token || !/^\d{15,22}$/.test(String(guildId || ""))) return send(res,503,{error:"لم يتم إعداد اتصال بوت Discord والسيرفر."});
  const targetId=String(body.discord_user_id||"");
  const action=body.action==="remove"?"remove":body.action==="assign"?"assign":"";
  if(!action||!/^\d{15,22}$/.test(targetId))return send(res,400,{error:"اختر عضوًا وإجراءً صحيحًا."});
  const profileResponse=await supabase(url,key,"staff_profiles?discord_user_id=eq."+encodeURIComponent(targetId)+"&select=discord_user_id,display_name,username,avatar_url,is_active,is_banned&limit=1");
  if(!profileResponse.ok)return send(res,503,{error:"تعذّر التحقق من تسجيل العضو في الموقع."});
  const profile=(await profileResponse.json())[0];
  if(!profile)return send(res,404,{error:"هذا الحساب غير مسجل في الموقع."});
  if(profile.is_active===false||profile.is_banned)return send(res,409,{error:"لا يمكن تعيين حساب موقوف أو محظور من الموقع."});
  const guild=await assignmentGuildContext(token,guildId);
  if(!guild.canManageRoles)return send(res,409,{error:"البوت لا يمتلك صلاحية Manage Roles في سيرفر Discord."});
  const rankRoles=assignmentRankList(guild.roles,Number(guild.botTop.position),guildId,guild.canManageRoles);
  const roleId=action==="assign"?String(body.rank_role_id||""):"";
  const targetRole=roleId?rankRoles.find(role=>role.id===roleId):null;
  if(action==="assign"&&(!targetRole||!targetRole.assignable))
    return send(res,409,{error:"الرتبة المختارة غير قابلة للتعيين. تأكد أن رتبة البوت أعلى منها وأنها ليست رتبة مُدارة أو @everyone."});
  const callsign=action==="assign"?assignmentCallsign(body.callsign):null;
  const member=await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId);
  const originalRoles=[...(member.roles||[])];
  const previousResponse=await supabase(url,key,"staff_assignments?discord_user_id=eq."+encodeURIComponent(targetId)+"&select=rank_role_id,status&limit=1");
  if(!previousResponse.ok)return send(res,503,{error:"تعذّر قراءة التعيين السابق قبل تحديث الرتبة."});
  const previousAssignment=(await previousResponse.json())[0]||null;
  const replaceableRoleIds=new Set(
    guild.roles.filter(role=>assignmentRankKey(role.name)).map(role=>String(role.id))
  );
  if(previousAssignment?.rank_role_id)replaceableRoleIds.add(String(previousAssignment.rank_role_id));
  const rolesToReplace=guild.roles.filter(role=>replaceableRoleIds.has(String(role.id))&&originalRoles.includes(String(role.id)));
  const blocking=rolesToReplace.find(role=>{
    const available=rankRoles.find(item=>item.id===role.id);
    return !available?.assignable;
  });
  if(blocking)return send(res,409,{error:"لا يستطيع البوت إزالة رتبة التعيين الحالية «"+blocking.name+"». ارفع رتبة البوت فوقها أولًا أو أزلها يدويًا."});
  const next=new Set(originalRoles);
  for(const role of rolesToReplace)next.delete(String(role.id));
  if(action==="assign")next.add(targetRole.id);
  const desiredRoles=[...next];
  const roleChanged=originalRoles.join(",")!==desiredRoles.join(",");
  if(roleChanged)await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId,{method:"PATCH",body:JSON.stringify({roles:desiredRoles})});
  const reference=crypto.randomUUID(),name=assignmentMemberName(member,profile.display_name||"Discord user");
  const rankName=action==="assign"?targetRole.name:null;
  const embed=assignmentEmbed({assigned:action==="assign",name,discordId:targetId,avatar:assignmentAvatar(member,guildId)||profile.avatar_url||null,rankName,callsign,actor:user.displayName||user.username,reference});
  let dm=null;
  try { dm=await assignmentSendDm(token,targetId,embed); }
  catch(error) {
    if(roleChanged)try{await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId,{method:"PATCH",body:JSON.stringify({roles:originalRoles})});}
    catch(rollback){console.error("Assignment rollback after DM failure:",rollback.code||rollback.message);return send(res,502,{error:"فشل إرسال الخاص وفشل التراجع عن الرتب. راجع رتب العضو يدويًا."});}
    return send(res,502,{error:error.message||"تعذّر إرسال رسالة التعيين الخاصة. تم التراجع عن تعديل الرتبة."});
  }
  try {
    const saved=await supabase(url,key,"rpc/save_staff_assignment",{method:"POST",body:JSON.stringify({
      p_discord_user_id:targetId,p_display_name:name,p_username:member.user?.username||profile.username||"",
      p_avatar_url:assignmentAvatar(member,guildId)||profile.avatar_url||"",
      p_rank_role_id:action==="assign"?targetRole.id:null,p_rank_role_name:action==="assign"?targetRole.name:null,
      p_callsign:callsign,p_status:action==="assign"?"assigned":"unassigned",
      p_actor_discord_id:user.id,p_actor_name:user.displayName||user.username||"Portal owner"
    })});
    if(!saved.ok){const detail=(await saved.text()).slice(0,400);throw Object.assign(new Error(detail),{code:"assignment_database_write_failed"});}
    const result=await saved.json();
    return send(res,200,{ok:true,action,assignment:result.after,dm_status:"sent",reference});
  } catch(error) {
    let rollbackFailed=false;
    if(roleChanged)try{await assignmentDiscord(token,"/guilds/"+guildId+"/members/"+targetId,{method:"PATCH",body:JSON.stringify({roles:originalRoles})});}
    catch(rollback){rollbackFailed=true;console.error("Assignment rollback after database failure:",rollback.code||rollback.message);}
    try{await assignmentDeleteDm(token,dm);}catch(removeError){console.error("Could not withdraw assignment DM:",removeError.code||removeError.message);}
    return send(res,502,{error:rollbackFailed?"فشل حفظ التعيين وفشل التراجع عن رتب Discord. يلزم مراجعة العضو يدويًا.":"تعذّر حفظ سجل التعيين؛ تم التراجع عن تغيير رتب Discord ومحاولة حذف الرسالة الخاصة.",rollback_failed:rollbackFailed});
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const user = session(req);
  if (!user) return send(res, 401, { error: "Authentication required" });
  if (!user.isOwner) return send(res, 403, { error: "Owner permission required" });
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return send(res, 503, { error: "Database is not configured" });
  try {
    const searchParams = new URL(req.url, "https://portal.invalid").searchParams;
    if (req.method === "GET" && searchParams.get("assignments") === "1") {
      const token = process.env.DISCORD_BOT_TOKEN, guildId = process.env.DISCORD_GUILD_ID;
      try { return send(res, 200, await listAssignments(url,key,token,guildId)); }
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
        select: "discord_user_id,display_name,username,avatar_url,is_active,is_banned,is_manual,last_seen,last_login,login_count,created_at,updated_at",
        order: "last_seen.desc.nullslast"
      });
      const response = await supabase(url, key, "staff_profiles?" + q);
      if (response.ok) {
        const members = await response.json();
        const normalized = members.map((m) => ({ ...m, is_active: m.is_active !== false, is_banned: Boolean(m.is_banned), last_seen: m.last_seen || null, last_login: m.last_login || null, login_count: Number(m.login_count || 0) }));
        return send(res, 200, { members: await mergeLoginEvents(url, key, normalized), ownerId: process.env.DISCORD_OWNER_ID, migrationRequired: false });
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
      const members = await fallback.json();
      return send(res, 200, {
        members: members.map((m) => ({
          ...m,
          is_banned: false,
          last_seen: null,
          last_login: null,
          login_count: 0,
        })),
        ownerId: process.env.DISCORD_OWNER_ID,
        migrationRequired: true,
        warning: "Directory loaded without activity tracking. Apply the admin controls migration to enable login counts, last activity, bans, and site settings.",
      });
    }
    if (req.method === "POST") {
      if (!requireSameOrigin(req,res)) return;
      const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch { return {}; } })() : (req.body || {});
      if(body.action==="add_manual_member")
        return await handleAddManualMember(url,key,process.env.DISCORD_BOT_TOKEN,process.env.DISCORD_GUILD_ID,user,body,res);
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
    if (!/^\d{15,22}$/.test(targetId) || !["ban", "unban", "deactivate", "activate"].includes(action))
      return send(res, 400, { error: "Invalid member action" });
    if (targetId === process.env.DISCORD_OWNER_ID)
      return send(res, 403, { error: "The protected owner cannot be modified." });
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
    try {
      await supabase(url, key, "audit_logs", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({
        actor_discord_id: user.id, actor_name: user.displayName || user.username, action: "permission_change",
        entity_type: "staff_profile", entity_id: targetId, details: { change: action, target_name: rows[0].display_name || targetId }
      })});
    } catch {}
    return send(res, 200, { ok: true, member: rows[0] });
  } catch (e) {
    console.error("Admin members API failed:", e?.message || "unknown");
    return send(res, 500, { error: "Personnel service failed." });
  }
}