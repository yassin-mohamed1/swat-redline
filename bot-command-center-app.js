(() => {
"use strict";
const API="/api/bot/command-center";
const state={data:null,view:"overview",lang:"ar",busy:false};
const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const esc=v=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const ar=()=>state.lang==="ar";
const t=(a,e)=>ar()?a:e;
function toast(message){const node=$("#toast");node.textContent=message;node.classList.add("show");setTimeout(()=>node.classList.remove("show"),3300);}
function badge(label,kind){return '<span class="badge '+(kind||"")+'">'+label+'</span>';}
function metric(label,value,note){return '<div class="card"><div class="kicker">'+label+'</div><div class="value">'+esc(value)+'</div><div class="caption">'+note+'</div></div>';}
function head(title,description,action){return '<div class="view-head"><div><h1>'+title+'</h1><p>'+description+'</p></div>'+(action||"")+'</div>';}
function apiError(data){return data&&data.error?data.error:t("تعذر تنفيذ العملية.","The request could not be completed.");}
async function request(path,options){const response=await fetch(path,{credentials:"same-origin",cache:"no-store",...(options||{})});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(apiError(data));return data;}
async function post(data){return request(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(data)});}
function render(){
  const data=state.data||{};
  $$("[data-view]").forEach(button=>button.classList.toggle("active",button.dataset.view===state.view));
  $("#mainView").dir=ar()?"rtl":"ltr";
  if(state.view==="overview")renderOverview(data);
  else if(state.view==="server")renderServer(data);
  else if(state.view==="messages")renderMessages(data);
  else if(state.view==="moderation")renderModeration();
  else if(state.view==="automod")renderAutoMod(data);
  else if(state.view==="integrations")renderIntegrations();
  else renderModules(data);
  $("#connectionBadge").textContent=data.connection&&data.connection.rest==="verified"?t("Discord API تم التحقق","Discord API verified"):t("الاتصال غير متاح","Connection unavailable");
  $("#connectionBadge").style.color=data.connection&&data.connection.rest==="verified"?"#7fe5ba":"#f3c477";
}
function renderOverview(data){
  const guild=data.guild||{},bot=data.bot||{},caps=data.capabilities||[];
  $("#mainView").innerHTML=
    head(t("نظرة عامة","Overview"),t("حالة اتصال Discord الفعلية وملخص السيرفر والأنظمة الموجودة في مشروعك.","Verified Discord API connection, server summary and existing project capabilities."))+
    '<div class="grid">'+
      metric(t("السيرفر","Server"),guild.name||"—",t("تم جلب البيانات من Discord","Fetched from Discord"))+
      metric(t("عدد الأعضاء التقريبي","Approx. members"),Number(guild.approximateMemberCount||0).toLocaleString(),t("بحسب Discord","Reported by Discord"))+
      metric(t("الرتب","Roles"),(data.roles||[]).length,t("رتب السيرفر","Server roles"))+
      metric(t("القنوات","Channels"),(data.channels||[]).length,t("قنوات يمكن للبوت قراءتها","Channels visible to the bot"))+
    '</div>'+
    '<div class="grid two">'+
      '<section class="panel"><div class="panel-head"><h2>'+t("هوية البوت","Bot identity")+'</h2>'+badge(t("REST متحقق","REST verified"))+'</div><div class="panel-body">'+
        '<div class="row">'+(bot.avatar?'<img src="'+esc(bot.avatar)+'" alt="" style="width:48px;height:48px;border-radius:14px">':"")+
        '<div><b>'+esc(bot.globalName||bot.username||"S.W.A.T. Bot")+'</b><div class="muted">@'+esc(bot.username||"")+' · '+esc(bot.id||"")+'</div></div></div>'+
        '<p class="muted">'+t("تم التحقق من التوكن وقدرة الموقع على الاتصال بـ Discord REST. هذا لا يؤكد وحده أن عملية Gateway المستمرة تعمل.","The token and Discord REST API are verified. This alone does not prove that the persistent Gateway worker is connected.")+'</p>'+
        badge(t("حالة Gateway غير مقاسة بعد","Gateway heartbeat not measured"),"warn")+
      '</div></section>'+
      '<section class="panel"><div class="panel-head"><h2>'+t("الأنظمة الموجودة حاليًا","Existing capabilities")+'</h2>'+badge(caps.filter(x=>x.status==="existing").length+" "+t("موجود","existing"))+'</div><div class="panel-body"><div class="list">'+
        caps.filter(x=>x.status==="existing"||x.status==="available_now").map(x=>'<div class="item"><span>'+esc(x.label)+'</span>'+badge(x.status==="existing"?t("موجود بالفعل","Existing"):t("متاح الآن","Available now"),x.status==="existing"?"":"warn")+'</div>').join("")+
      '</div></div></section>'+
    '</div>'+
    '<div class="notice">'+t("ملاحظة مهمة: الترحيب التلقائي وAutoMod والتذاكر والمستويات تحتاج مستمعات Gateway وخدمات تشغيل داخل البوت. لن نعرض أي نظام منها على أنه مفعّل قبل تنفيذه واختباره.","Important: welcome automation, AutoMod, tickets and leveling require Gateway event listeners and persistent bot services. They will not be shown as enabled until implemented and tested.")+'</div>';

 $("#mainView").insertAdjacentHTML("beforeend",
  '<section class="panel"><div class="panel-head"><h2>'+t("أدوات S.W.A.T. الموجودة بالفعل","Existing S.W.A.T. tools")+'</h2>'+badge(t("مرتبطة بالبوابة","Linked to portal"))+'</div><div class="panel-body"><div class="row">'+
  '<button class="btn" type="button" data-portal-page="personnel">'+t("الأفراد","Personnel")+'</button>'+
  '<button class="btn" type="button" data-portal-page="warnings">'+t("التحذيرات","Warnings")+'</button>'+
  '<button class="btn" type="button" data-portal-page="messages">'+t("إرسال الرسائل","Messaging")+'</button>'+
  '<button class="btn" type="button" data-portal-page="attendance">'+t("البصمة والإجازات","Attendance & leaves")+'</button>'+
  '<button class="btn" type="button" data-portal-page="audit">'+t("سجل الإدارة","Audit log")+'</button>'+
  '</div><p class="muted">'+t("هذه الوظائف موجودة بالفعل في بوابة S.W.A.T. ويمكن فتحها من هنا.","These capabilities already exist in the S.W.A.T. portal and can be opened here.")+'</p></div></section>');
 $("[data-portal-page]").forEach(button=>button.addEventListener("click",()=>window.parent.postMessage({type:"swat-bot-open-portal-page",page:button.dataset.portalPage},location.origin)));
}
function renderServer(data){
 const roles=data.roles||[],channels=data.channels||[];
 const roleOptions=roles.filter(r=>!r.managed&&r.id!==(data.guild||{}).id).map(r=>'<option value="'+esc(r.id)+'">'+esc(r.name)+' · '+esc(r.id)+'</option>').join("");
 const textChannels=channels.filter(c=>[0,5].includes(c.type));
 $("#mainView").innerHTML=
  head(t("السيرفر والرتب","Server & roles"),t("عرض الرتب والقنوات وإدارة رتب الأعضاء باستخدام اتصال البوت الحالي.","Inspect roles and channels, and manage member roles through the existing bot connection."))+
  '<div class="grid">'+metric(t("الرتب","Roles"),roles.length,t("مرتبة حسب الموقع","Sorted by position"))+
  metric(t("قنوات النصوص","Text channels"),textChannels.length,t("تشمل الإعلانات","Including announcements"))+
  metric(t("قنوات الصوت","Voice channels"),channels.filter(c=>[2,13].includes(c.type)).length,t("صوت ومسرح","Voice and stage"))+
  metric(t("الفئات","Categories"),channels.filter(c=>c.type===4).length,t("تنظيم القنوات","Channel categories"))+'</div>'+
  '<div class="grid two">'+
   '<section class="panel"><div class="panel-head"><h2>'+t("إدارة رتبة عضو","Member role manager")+'</h2></div><div class="panel-body">'+
    '<form id="roleForm"><div class="field"><label>'+t("Discord User ID","Discord User ID")+'</label><input name="userId" inputmode="numeric" pattern="[0-9]{15,22}" required placeholder="123456789012345678"></div>'+
    '<div class="field"><label>'+t("الرتبة","Role")+'</label><select name="roleId" required><option value="">'+t("اختر رتبة","Select role")+'</option>'+roleOptions+'</select></div>'+
    '<div class="row"><button class="btn primary" type="submit" data-action="add_role">'+t("إضافة الرتبة","Add role")+'</button><button class="btn danger" type="submit" data-action="remove_role">'+t("إزالة الرتبة","Remove role")+'</button></div></form>'+
    '<p class="muted">'+t("يتم فحص ترتيب الرتب. لا يمكن تعديل الرتب الأعلى من رتبة البوت أو حساب المالك المحمي.","Role hierarchy is checked. Roles above the bot and the protected owner account cannot be modified.")+'</p>'+
   '</div></section>'+
   '<section class="panel"><div class="panel-head"><h2>'+t("رتب السيرفر","Server roles")+'</h2>'+badge(roles.length)+'</div><div class="panel-body"><div class="list">'+roles.map(r=>'<div class="item"><span><i class="dot" style="background:'+(r.color?"#"+Number(r.color).toString(16).padStart(6,"0"):"#69788b")+'"></i>'+esc(r.name)+'</span><span class="muted">#'+r.position+(r.managed?" · Managed":"")+'</span></div>').join("")+'</div></div></section>'+
  '</div>'+
  '<section class="panel"><div class="panel-head"><h2>'+t("قنوات السيرفر","Server channels")+'</h2>'+badge(channels.length)+'</div><div class="panel-body"><div class="list">'+channels.map(c=>'<div class="item"><span>'+(c.type===2||c.type===13?"◖":c.type===4?"▱":c.type===5?"▤":"#")+' '+esc(c.name)+'</span><span class="muted">'+esc(c.id)+'</span></div>').join("")+'</div></div></section>';
 const roleForm=$("#roleForm");
 roleForm.addEventListener("submit",async event=>{
  event.preventDefault();const action=event.submitter&&event.submitter.dataset.action||"add_role";const values=new FormData(roleForm);
  const payload={action,userId:String(values.get("userId")||"").trim(),roleId:String(values.get("roleId")||"")};
  if(!confirm(t(action==="add_role"?"تأكيد إضافة الرتبة للعضو؟":"تأكيد إزالة الرتبة من العضو؟",action==="add_role"?"Confirm adding the role?":"Confirm removing the role?")))return;
  try{await post(payload);toast(t("تم تحديث رتب العضو.","Member roles updated."));roleForm.reset();}catch(error){toast(error.message);}
 });
}
function renderMessages(data){
 const channels=(data.channels||[]).filter(c=>[0,5].includes(c.type));
 $("#mainView").innerHTML=head(t("الرسائل والإعلانات","Messages & announcements"),t("إرسال رسالة إلى قناة نصية أو قناة إعلانات داخل سيرفر S.W.A.T.","Send a message to a text or announcement channel in your S.W.A.T. server."))+
 '<section class="panel"><div class="panel-head"><h2>'+t("إنشاء رسالة","Compose message")+'</h2>'+badge(t("إرسال مباشر","Direct send"),"warn")+'</div><div class="panel-body">'+
 '<form id="messageForm"><div class="field"><label>'+t("القناة المستهدفة","Target channel")+'</label><select name="channelId" required><option value="">'+t("اختر القناة","Select channel")+'</option>'+channels.map(c=>'<option value="'+esc(c.id)+'"># '+esc(c.name)+'</option>').join("")+'</select></div>'+
 '<div class="field"><label>'+t("محتوى الرسالة","Message content")+'</label><textarea name="content" maxlength="2000" required placeholder="'+t("اكتب الإعلان أو الرسالة...","Write the announcement or message...")+'"></textarea><div class="muted">'+t("حتى 2000 حرف. المنشن الجماعي @everyone و@here معطل تلقائيًا.","Up to 2,000 characters. @everyone and @here mentions are disabled by default.")+'</div></div>'+
 '<div class="row"><button class="btn primary" type="submit">'+t("إرسال إلى Discord","Send to Discord")+'</button><button class="btn" type="reset">'+t("مسح","Clear")+'</button></div></form></div></section>'+
 '<div class="notice">'+t("لن تُرسل أي رسالة إلا بعد ضغطك على إرسال وتأكيد العملية. كل إرسال يُسجّل في سجل الإدارة.","No message is sent until you submit and confirm. Every send is recorded in the admin audit log.")+'</div>';
 $("#messageForm").addEventListener("submit",async event=>{
  event.preventDefault();const values=new FormData(event.currentTarget);const channelId=String(values.get("channelId")||"");const content=String(values.get("content")||"").trim();if(!channelId||!content)return;
  if(!confirm(t("سيتم إرسال الرسالة الآن إلى القناة المحددة. هل تريد المتابعة؟","Send this message to the selected channel now?")))return;
  try{const result=await post({action:"send_message",channelId,content});toast(t("تم إرسال الرسالة إلى #"+result.channelName,"Message sent to #"+result.channelName));event.currentTarget.reset();}catch(error){toast(error.message);}
 });
}
function renderModeration(){
 $("#mainView").innerHTML=head(t("الإشراف والعقوبات","Moderation"),t("تنفيذ Timeout أو Kick أو Ban أو Unban من خلال البوت مع فحص ترتيب الرتب.","Apply Timeout, Kick, Ban or Unban through the bot with role hierarchy checks."))+
 '<section class="panel"><div class="panel-head"><h2>'+t("إجراء إشرافي","Moderation action")+'</h2>'+badge(t("يتطلب تأكيدًا","Confirmation required"),"warn")+'</div><div class="panel-body">'+
 '<form id="moderationForm"><div class="split"><div class="field"><label>Discord User ID</label><input name="userId" inputmode="numeric" pattern="[0-9]{15,22}" required placeholder="123456789012345678"></div>'+
 '<div class="field"><label>'+t("نوع الإجراء","Action")+'</label><select name="kind"><option value="timeout">Timeout</option><option value="kick">Kick</option><option value="ban">Ban</option><option value="unban">Unban</option></select></div></div>'+
 '<div class="field" id="timeoutField"><label>'+t("مدة Timeout بالدقائق","Timeout duration in minutes")+'</label><select name="minutes"><option value="10">10</option><option value="60">60</option><option value="1440">24 hours</option><option value="10080">7 days</option><option value="40320">28 days</option></select></div>'+
 '<div class="field"><label>'+t("السبب","Reason")+'</label><textarea name="reason" maxlength="400" placeholder="'+t("سبب الإجراء وسيُسجل في Discord Audit Log","Reason, recorded in Discord Audit Log")+'"></textarea></div>'+
 '<button class="btn danger" type="submit">'+t("تنفيذ الإجراء","Execute action")+'</button></form></div></section>'+
 '<div class="notice">'+t("الإجراءات الحساسة لا يمكن التراجع عنها دائمًا. تأكد من Discord User ID والسبب. لن يتم استهداف حساب المالك المحمي أو عضو أعلى من البوت في ترتيب الرتب.","Sensitive actions may not be reversible. Verify the User ID and reason. The protected owner and members above the bot hierarchy cannot be targeted.")+'</div>';
 const form=$("#moderationForm"),kind=form.elements.kind,timeout=$("#timeoutField");
 kind.addEventListener("change",()=>timeout.style.display=kind.value==="timeout"?"":"none");
 timeout.style.display=kind.value==="timeout"?"":"none";
 form.addEventListener("submit",async event=>{
  event.preventDefault();const values=new FormData(form);const payload={action:"moderate",userId:String(values.get("userId")||"").trim(),kind:String(values.get("kind")||""),minutes:Number(values.get("minutes")||10),reason:String(values.get("reason")||"").trim()};
  if(!payload.userId)return;
  const names={timeout:"Timeout",kick:"Kick",ban:"Ban",unban:"Unban"};
  if(!confirm(t("تأكيد تنفيذ "+names[payload.kind]+" على العضو "+payload.userId+"؟","Confirm "+names[payload.kind]+" for member "+payload.userId+"?")))return;
  try{await post(payload);toast(t("تم تنفيذ الإجراء بنجاح.","Moderation action completed."));form.reset();timeout.style.display="";}catch(error){toast(error.message);}
 });
}
function renderAutoMod(data){
 const automod=data.automod||{available:false,rules:[]};
 const channels=(data.channels||[]).filter(c=>[0,5].includes(c.type));
 const rules=automod.rules||[];
 const unavailable=!automod.available;
 $("#mainView").innerHTML=
  head(t("الحماية التلقائية","Auto Moderation"),t("إنشاء وإدارة قواعد الحماية الأصلية في Discord. القواعد تعمل من Discord نفسه بعد تفعيلها.","Create and manage native Discord Auto Moderation rules. Discord enforces enabled rules directly."))+
  (unavailable?'<div class="notice">'+t("البوت لم يحصل بعد على صلاحية Manage Server / Manage Guild أو قراءة قواعد AutoMod. امنحه الصلاحية ثم حدّث الصفحة.","The bot does not currently have the Manage Server / Manage Guild permission to read AutoMod rules. Grant the permission and refresh.")+'</div>':'')+
  '<div class="grid">'+metric(t("قواعد الحماية","Protection rules"),rules.length,t("قواعد موجودة في Discord","Rules configured in Discord"))+
  metric(t("القواعد النشطة","Enabled rules"),rules.filter(r=>r.enabled).length,t("يتم تطبيقها من Discord","Enforced by Discord"))+
  metric(t("قواعد الكلمات","Keyword rules"),rules.filter(r=>r.triggerType===1).length,t("فلترة الكلمات والعبارات","Keyword and phrase filtering"))+
  metric(t("منع المنشن الزائد","Mention spam"),rules.filter(r=>r.triggerType===5).length,t("الحد من الإشارات الجماعية","Limit excessive mentions"))+'</div>'+
  '<div class="grid two">'+
   '<section class="panel"><div class="panel-head"><h2>'+t("إنشاء قاعدة حماية","Create a protection rule")+'</h2>'+badge(t("Discord Native","Discord Native"))+'</div><div class="panel-body">'+
    '<form id="autoModCreateForm">'+
     '<div class="field"><label>'+t("اسم القاعدة","Rule name")+'</label><input name="name" maxlength="100" required placeholder="'+t("مثال: منع الكلمات غير المسموحة","Example: Block prohibited words")+'"></div>'+
     '<div class="field"><label>'+t("نوع القاعدة","Rule type")+'</label><select name="kind" id="autoModKind"><option value="keyword">'+t("الكلمات والعبارات الممنوعة","Blocked keywords and phrases")+'</option><option value="mention_spam">'+t("منع الإشارات المتكررة","Excessive mention spam")+'</option></select></div>'+
     '<div class="field" id="autoModKeywordsField"><label>'+t("الكلمات — كل كلمة في سطر","Keywords — one per line")+'</label><textarea name="keywords" maxlength="6500" placeholder="'+t("كلمة ممنوعة\nعبارة ممنوعة","blocked-word\nblocked phrase")+'"></textarea><div class="muted">'+t("حتى 100 كلمة، 60 حرفًا لكل كلمة. Discord سيمنع الرسالة المخالفة.","Up to 100 terms, 60 characters each. Discord blocks matching messages.")+'</div></div>'+
     '<div class="field" id="autoModMentionField" style="display:none"><label>'+t("أقصى عدد من المنشن في الرسالة","Maximum mentions per message")+'</label><select name="mentionLimit"><option value="3">3</option><option value="5" selected>5</option><option value="8">8</option><option value="10">10</option><option value="15">15</option></select></div>'+
     '<div class="field"><label>'+t("قناة تنبيهات الإدارة (اختياري)","Admin alert channel (optional)")+'</label><select name="alertChannelId"><option value="">'+t("بدون تنبيه إضافي","No extra alert")+'</option>'+channels.map(c=>'<option value="'+esc(c.id)+'"># '+esc(c.name)+'</option>').join("")+'</select></div>'+
     '<button class="btn primary" type="submit" '+(unavailable?'disabled':'')+'>'+t("إنشاء وتفعيل القاعدة","Create and enable rule")+'</button>'+
    '</form></div></section>'+
    '<section class="panel"><div class="panel-head"><h2>'+t("قواعد السيرفر الحالية","Current server rules")+'</h2>'+badge(rules.length)+'</div><div class="panel-body">'+
     (rules.length?'<div class="list">'+rules.map(rule=>'<div class="item" style="align-items:flex-start"><div style="min-width:0"><b>'+esc(rule.name)+'</b><div class="muted">'+(rule.triggerType===1?t("فلترة كلمات","Keyword filter") : rule.triggerType===5?t("منع المنشن الزائد","Mention spam"):t("نوع آخر","Other trigger"))+' · '+(rule.triggerType===1?rule.keywordCount+" "+t("كلمة","terms"):rule.mentionLimit+" "+t("منشن","mentions"))+'</div></div><div class="row">'+badge(rule.enabled?t("نشطة","Enabled"):t("متوقفة","Disabled"),rule.enabled?"":"warn")+'<button class="btn" type="button" data-automod-toggle="'+esc(rule.id)+'" data-enabled="'+(!rule.enabled)+'">'+(rule.enabled?t("إيقاف","Disable"):t("تفعيل","Enable"))+'</button><button class="btn danger" type="button" data-automod-delete="'+esc(rule.id)+'">'+t("حذف","Delete")+'</button></div></div>').join("")+'</div>':'<div class="empty">'+t("لا توجد قواعد AutoMod بعد. أنشئ أول قاعدة من النموذج.","No AutoMod rules yet. Create your first rule using the form.")+'</div>')+
    '</div></section>'+
  '</div>'+
  '<div class="notice">'+t("تنبيه: قاعدة الكلمات تستخدم إجراء Block Message. قناة التنبيه اختيارية. تأكد من إعفاء قنوات الإدارة والرتب المناسبة داخل إعدادات Discord قبل تفعيل سياسات واسعة.","Note: keyword rules use the Block Message action. The alert channel is optional. Review exemptions for staff roles and channels in Discord before applying broad policies.")+'</div>';
 const form=$("#autoModCreateForm"),kind=$("#autoModKind"),words=$("#autoModKeywordsField"),mentions=$("#autoModMentionField");
 kind.addEventListener("change",()=>{const keyword=kind.value==="keyword";words.style.display=keyword?"":"none";mentions.style.display=keyword?"none":"";});
 form.addEventListener("submit",async event=>{
  event.preventDefault();const values=new FormData(form);
  const payload={action:"create_automod_rule",name:String(values.get("name")||"").trim(),kind:String(values.get("kind")||""),keywords:String(values.get("keywords")||""),mentionLimit:Number(values.get("mentionLimit")||5),alertChannelId:String(values.get("alertChannelId")||"")};
  if(payload.kind==="keyword"&&!payload.keywords.trim()){toast(t("أدخل كلمة واحدة على الأقل.","Enter at least one keyword."));return;}
  if(!confirm(t("سيتم إنشاء قاعدة وتفعيلها داخل سيرفر Discord. هل تريد المتابعة؟","This will create and enable a rule in your Discord server. Continue?")))return;
  try{await post(payload);toast(t("تم إنشاء قاعدة الحماية وتفعيلها.","Auto Moderation rule created and enabled."));await load();state.view="automod";render();}catch(error){toast(error.message);}
 });
 $("[data-automod-toggle]").forEach(button=>button.addEventListener("click",async()=>{
  const enabled=button.dataset.enabled==="true";
  if(!confirm(t(enabled?"تفعيل قاعدة الحماية؟":"إيقاف قاعدة الحماية؟",enabled?"Enable this protection rule?":"Disable this protection rule?")))return;
  try{await post({action:"toggle_automod_rule",ruleId:button.dataset.automodToggle,enabled});toast(t("تم تحديث حالة القاعدة.","Rule status updated."));await load();state.view="automod";render();}catch(error){toast(error.message);}
 }));
 $("[data-automod-delete]").forEach(button=>button.addEventListener("click",async()=>{
  if(!confirm(t("حذف قاعدة AutoMod نهائيًا؟","Permanently delete this AutoMod rule?")))return;
  try{await post({action:"delete_automod_rule",ruleId:button.dataset.automodDelete});toast(t("تم حذف القاعدة.","Rule deleted."));await load();state.view="automod";render();}catch(error){toast(error.message);}
 }));
}
function renderIntegrations(){
 const list=[
 ["YouTube",t("تنبيهات الفيديوهات والبث المباشر","Video and livestream alerts"),t("يتطلب إضافة مصدر القنوات ومراقب مستمر","Requires channel subscriptions and a persistent poller")],
 ["Twitch",t("تنبيهات بداية ونهاية البث","Stream start and end alerts"),t("يتطلب OAuth / EventSub","Requires OAuth / EventSub")],
 ["Kick",t("تنبيهات البث","Stream alerts"),t("يتطلب مصدر بيانات مستقر","Requires a reliable data source")],
 ["RSS",t("متابعة خلاصات المواقع","Website feed monitoring"),t("يتطلب Poller مستمر","Requires a persistent poller")],
 ["Reddit",t("تنبيهات Subreddit","Subreddit alerts"),t("يتطلب تكامل API","Requires API integration")],
 ["Bluesky",t("متابعة منشورات الحسابات","Account post monitoring"),t("يتطلب Poller وتخزين الاشتراكات","Requires a poller and subscription storage")]
 ];
 $("#mainView").innerHTML=head(t("التكاملات الخارجية","External integrations"),t("تكاملات مفيدة نضيفها إلى بوت S.W.A.T. بدل الاعتماد على Koya.","Useful integrations to bring into the S.W.A.T. bot, replacing Koya."))+
 '<div class="notice">'+t("دي قائمة العمل المطلوبة، وليست تكاملات مفعّلة الآن. لن تظهر كأنها تعمل قبل بناء خدمة المراقبة وربطها واختبارها.","This is the integration roadmap, not a list of active integrations. Each service will only be marked live after its listener is built and tested.")+'</div>'+
 '<div class="grid two">'+list.map(x=>'<div class="card"><div class="row" style="justify-content:space-between"><b>'+x[0]+'</b>'+badge(t("قيد التطوير","Planned"),"warn")+'</div><p class="muted">'+x[1]+'</p><div class="caption">'+x[2]+'</div></div>').join("")+'</div>';
}
function renderModules(data){
 const caps=data.capabilities||[];
 const labels={existing:t("موجود بالفعل","Existing"),available_now:t("متاح الآن","Available now"),needs_gateway:t("يتطلب تطوير البوت","Requires bot development"),needs_integrations:t("يتطلب تكامل خارجي","Requires integration"),needs_permission:t("صلاحية Discord مطلوبة","Discord permission required")};
 $("#mainView").innerHTML=head(t("حالة الأنظمة","System modules"),t("حالة واقعية للوظائف الموجودة والوظائف التي ما زالت تحتاج تطويرًا.","A transparent status view of existing and pending functions."))+
 '<section class="panel"><div class="panel-body"><div class="list">'+caps.map(x=>'<div class="item"><span>'+esc(x.label)+'</span>'+badge(labels[x.status]||esc(x.status),x.status==="existing"||x.status==="available_now"?"":"warn")+'</div>').join("")+'</div></div></section>';
}
async function load(){
 if(state.busy)return;state.busy=true;$("#refreshButton").disabled=true;
 $("#mainView").innerHTML='<div class="loading"><div><div class="spinner"></div>'+t("جاري الاتصال بـ Discord...","Connecting to Discord...")+'</div></div>';
 try{state.data=await request(API);render();}
 catch(error){$("#mainView").innerHTML='<div class="empty"><b>'+t("تعذر تحميل مركز التحكم","Command center could not load")+'</b><p>'+esc(error.message)+'</p><button class="btn primary" id="retryButton">'+t("إعادة المحاولة","Retry")+'</button></div>';$("#retryButton").addEventListener("click",load);$("#connectionBadge").textContent=t("الاتصال غير متاح","Connection unavailable");}
 finally{state.busy=false;$("#refreshButton").disabled=false;}
}
function init(){
 $$("[data-view]").forEach(button=>button.addEventListener("click",()=>{state.view=button.dataset.view;render();}));
 $("#refreshButton").addEventListener("click",load);
 $("#languageButton").addEventListener("click",()=>{state.lang=ar()?"en":"ar";document.documentElement.lang=state.lang;document.documentElement.dir=ar()?"rtl":"ltr";$("#languageButton").textContent=ar()?"EN":"عربي";$$("[data-view]").forEach(button=>{const labels={overview:["نظرة عامة","Overview"],server:["السيرفر والرتب","Server & roles"],messages:["الرسائل والإعلانات","Messages & announcements"],moderation:["الإشراف والعقوبات","Moderation"],integrations:["التكاملات الخارجية","Integrations"],modules:["حالة الأنظمة","System modules"]};const item=labels[button.dataset.view];button.lastChild.textContent=ar()?item[0]:item[1];});render();});
 $("#backButton").addEventListener("click",()=>window.parent.postMessage({type:"swat-bot-command-center-close"},location.origin));
 load();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();