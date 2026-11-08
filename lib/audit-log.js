import { discordApiRequest } from "./discord-rest.js";
const AUDIT_CHANNEL_ID = String(process.env.DISCORD_AUDIT_CHANNEL_ID || "1569047013402738829");
const SENSITIVE_VALUE = /(?:Bearer\s+[A-Za-z0-9._~+\/-]+=*|mfa\.[A-Za-z0-9_-]{20,}|(?:password|passwd|token|secret|api[_-]?key|client[_-]?secret)\s*[:=]\s*[^\s,;]{4,})/i;
function safeAuditText(value, max = 700) {
  let text = String(value ?? "").replace(/<@!?\d{15,22}>/g,"[Discord user]").replace(/<@&\d{15,22}>/g,"[Discord role]").replace(/https?:\/\/\S+/gi,"[link]");
  if(SENSITIVE_VALUE.test(text))return "[content omitted: possible secret]";
  text=text.replace(/\s+/g," ").trim();
  return text.length>max?text.slice(0,max-1)+"…":text;
}
function makeEmbed(event) {
  const details=event.details&&typeof event.details==="object"?event.details:{};
  return {title:"S.W.A.T. REDLINE • Administrative Activity",color:0x24c77a,description:"A verified portal activity was recorded.",
    fields:[
      {name:"Actor",value:safeAuditText(event.actor_name||"Unknown user",100),inline:true},
      {name:"Discord ID",value:String(event.actor_discord_id||"—").slice(0,24),inline:true},
      {name:"Action",value:safeAuditText(event.action||"activity",40),inline:true},
      {name:"Category",value:safeAuditText(event.entity_type||event.entityType||"portal",80),inline:true},
      {name:"Reference",value:safeAuditText(event.entity_id??event.entityId??"—",100),inline:true},
      {name:"Summary",value:safeAuditText(details.detail||details.type||event.entity_type||"Portal activity",500),inline:false}
    ],footer:{text:"REDLINE Audit • Event saved to the Administration Log"},timestamp:new Date().toISOString()};
}
/** Forward only events that have already been written to the database. */
export async function forwardAuditEventsToDiscord(events) {
  const token=process.env.DISCORD_BOT_TOKEN;
  if(!token)return {ok:false,sent:0,reason:"bot_token_missing"};
  const rows=Array.isArray(events)?events.filter(row=>row&&typeof row==="object"):[];
  let sent=0,failed=0;
  for(let offset=0;offset<rows.length;offset+=5){
    const group=rows.slice(offset,offset+5);
    try{
      await discordApiRequest(token,"/channels/"+AUDIT_CHANNEL_ID+"/messages",{method:"POST",body:JSON.stringify({
        embeds:group.map(makeEmbed),allowed_mentions:{parse:[]}
      })},{maxRetries:2,maxRetryWaitMs:2500});
      sent+=group.length;
    }catch(error){failed+=group.length;console.error("Discord audit forward failed:",error?.status||"unknown",error?.message||"unknown");}
  }
  return {ok:failed===0,sent,failed};
}
export async function forwardAuditToDiscord(user,event){
  return forwardAuditEventsToDiscord([{...event,actor_discord_id:event?.actor_discord_id||user?.id,
    actor_name:event?.actor_name||user?.displayName||user?.username||"Unknown user"}]);
}
