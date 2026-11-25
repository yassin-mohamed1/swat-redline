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
  else if(state.view==="logs")renderLogs(data);
  else if(state.view==="welcome")renderWelcome(data);
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
 '<div class="notice">'+t("لن تُرسل أي رسالة إلا بعد ضغطك على إرسال وتأكيد العملية. كل إرسال يُسجّل في سجل الإدارة.","No message is sent until you submit and confirm. Every send is recorded in the admin audit log.")+'</div>'+
 '<section class="panel"><div class="panel-head"><h2>'+t("محرر رسائل Embed","Embed message builder")+'</h2>'+badge("DISCORD EMBED","neutral")+'</div><div class="panel-body">'+
 '<form id="embedForm"><div class="field"><label>'+t("القناة المستهدفة","Target channel")+'</label><select name="channelId" required><option value="">'+t("اختر القناة","Select channel")+'</option>'+channels.map(c=>'<option value="'+esc(c.id)+'"># '+esc(c.name)+'</option>').join("")+'</select></div>'+
 '<div class="split"><div class="field"><label>'+t("العنوان","Title")+'</label><input name="title" maxlength="256" placeholder="'+t("عنوان الإعلان","Announcement title")+'"></div><div class="field"><label>'+t("لون الشريط","Accent color")+'</label><input type="color" name="color" value="#ed3545" style="height:42px;padding:4px"></div></div>'+
 '<div class="field"><label>'+t("الوصف","Description")+'</label><textarea name="description" maxlength="4096" placeholder="'+t("اكتب تفاصيل الإعلان...","Write the announcement details...")+'"></textarea></div>'+
 '<div class="field"><label>'+t("تذييل الرسالة (اختياري)","Footer (optional)")+'</label><input name="footer" maxlength="2048" placeholder="S.W.A.T. REDLINE"></div>'+
 '<div class="row"><button class="btn primary" type="submit">'+t("إرسال Embed","Send Embed")+'</button><button class="btn" type="reset">'+t("مسح","Clear")+'</button></div></form></div></section>';
 $("#messageForm").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget;const values=new FormData(form);const channelId=String(values.get("channelId")||"");const content=String(values.get("content")||"").trim();if(!channelId||!content)return;
  if(!confirm(t("سيتم إرسال الرسالة الآن إلى القناة المحددة. هل تريد المتابعة؟","Send this message to the selected channel now?")))return;
  try{const result=await post({action:"send_message",channelId,content});toast(t("تم إرسال الرسالة إلى #"+result.channelName,"Message sent to #"+result.channelName));form.reset();}catch(error){toast(error.message);}
 });
 $("#embedForm").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget;const values=new FormData(form);
  const payload={action:"send_embed",channelId:String(values.get("channelId")||""),title:String(values.get("title")||"").trim(),description:String(values.get("description")||"").trim(),footer:String(values.get("footer")||"").trim(),color:String(values.get("color")||"#ed3545")};
  if(!payload.channelId||(!payload.title&&!payload.description)){toast(t("اختر قناة واكتب عنوانًا أو وصفًا.","Choose a channel and enter a title or description."));return;}
  if(!confirm(t("سيتم إرسال Embed الآن إلى القناة المختارة. هل تريد المتابعة؟","Send this embed to the selected channel now?")))return;
  try{const result=await post(payload);toast(t("تم إرسال Embed إلى #"+result.channelName,"Embed sent to #"+result.channelName));form.reset();}catch(error){toast(error.message);}
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
const LOG_CATEGORY_UI=[
 {id:"messages",title:["الرسائل","Messages"],description:["حذف وتعديل الرسائل والتثبيت والحذف الجماعي","Message delete, edits, pins and bulk deletion"],events:["messageDelete","messageUpdate","messageBulkDelete","messageDeleteAudit","messageBulkDeleteAudit","messagePin","messageUnpin"]},
 {id:"members",title:["الأعضاء","Members"],description:["الدخول والمغادرة وتعديل بيانات العضو","Join, leave and member updates"],events:["memberJoin","memberLeave","memberNicknameUpdate","memberUpdate"]},
 {id:"voice",title:["الرومات الصوتية","Voice channels"],description:["الدخول والخروج والانتقال بين الرومات","Voice join, leave and channel moves"],events:["voiceJoin","voiceLeave","voiceMove"]},
 {id:"roles",title:["الرتب","Roles"],description:["تغييرات رتب الأعضاء والرتب نفسها وترتيبها","Member role changes, role edits and ordering"],events:["memberRoleUpdate","roleCreate","roleUpdate","roleDelete","rolePositionUpdate"]},
 {id:"moderation",title:["الإشراف والعقوبات","Moderation"],description:["Kick وBan وUnban وTimeout وتنظيف ونقل الأعضاء","Kick, ban, unban, timeout, prune and member moves"],events:["kick","memberPrune","ban","unban","timeout","memberMove","memberDisconnect","botAdd"]},
 {id:"channels",title:["القنوات والصلاحيات","Channels & permissions"],description:["إنشاء القنوات وتعديلها وحذفها وكل تغييرات صلاحيات الرتب والأعضاء","Channel changes and all role/member permission overwrite changes"],events:["channelCreate","channelUpdate","channelDelete","channelOverwriteCreate","channelOverwriteUpdate","channelOverwriteDelete","channelPositionUpdate"]},
 {id:"server",title:["إعدادات السيرفر","Server settings"],description:["تغييرات إعدادات السيرفر الرئيسية","Guild-level settings changes"],events:["guildUpdate"]},
 {id:"audit",title:["سجل الإدارة والتكاملات","Audit log & integrations"],description:["الدعوات وWebhooks وAutoMod والفعاليات وThreads وباقي أحداث Audit Log","Invites, webhooks, AutoMod, events, threads and other audit actions"],events:["inviteCreate","inviteUpdate","inviteDelete","webhookCreate","webhookUpdate","webhookDelete","emojiCreate","emojiUpdate","emojiDelete","integrationCreate","integrationUpdate","integrationDelete","stageInstanceCreate","stageInstanceUpdate","stageInstanceDelete","stickerCreate","stickerUpdate","stickerDelete","guildScheduledEventCreate","guildScheduledEventUpdate","guildScheduledEventDelete","threadCreate","threadUpdate","threadDelete","applicationCommandPermissionUpdate","soundboardSoundCreate","soundboardSoundUpdate","soundboardSoundDelete","autoModerationRuleCreate","autoModerationRuleUpdate","autoModerationRuleDelete","autoModerationBlockMessage","autoModerationFlagToChannel","autoModerationUserCommunicationDisabled","autoModerationQuarantineUser","creatorMonetizationRequestCreated","creatorMonetizationTermsAccepted","onboardingPromptCreate","onboardingPromptUpdate","onboardingPromptDelete","onboardingCreate","onboardingUpdate","homeSettingsCreate","homeSettingsUpdate","voiceChannelStatusCreate","voiceChannelStatusDelete","auditLogOther"]}
];
const LOG_EVENT_LABELS={
 messageDelete:["حذف الرسائل","Message deleted"],messageUpdate:["تعديل الرسائل","Message edited"],messageBulkDelete:["حذف مجموعة رسائل","Bulk message delete"],messageDeleteAudit:["سجل حذف رسالة","Message deletion audit"],messageBulkDeleteAudit:["سجل حذف رسائل جماعي","Bulk deletion audit"],messagePin:["تثبيت رسالة","Message pinned"],messageUnpin:["إزالة تثبيت رسالة","Message unpinned"],
 memberJoin:["دخول عضو","Member joined"],memberLeave:["مغادرة عضو","Member left"],memberNicknameUpdate:["تغيير الاسم","Nickname changed"],memberUpdate:["تعديل بيانات عضو","Member updated"],
 voiceJoin:["دخول روم صوتي","Joined voice"],voiceLeave:["خروج من روم صوتي","Left voice"],voiceMove:["انتقال بين الرومات","Moved voice channel"],
 memberRoleUpdate:["تغيير رتب عضو","Member roles changed"],roleCreate:["إنشاء رتبة","Role created"],roleUpdate:["تعديل رتبة","Role updated"],roleDelete:["حذف رتبة","Role deleted"],rolePositionUpdate:["تغيير ترتيب الرتب","Role position changed"],
 kick:["طرد عضو","Member kicked"],memberPrune:["تنظيف أعضاء غير نشطين","Member prune"],ban:["حظر عضو","Member banned"],unban:["إلغاء حظر عضو","Member unbanned"],timeout:["Timeout","Timeout"],memberMove:["نقل عضو صوتيًا","Member moved"],memberDisconnect:["فصل عضو صوتيًا","Member disconnected"],botAdd:["إضافة بوت","Bot added"],
 channelCreate:["إنشاء قناة","Channel created"],channelUpdate:["تعديل إعدادات قناة","Channel updated"],channelDelete:["حذف قناة","Channel deleted"],channelOverwriteCreate:["إضافة صلاحيات قناة","Channel permissions added"],channelOverwriteUpdate:["تعديل صلاحيات قناة","Channel permissions updated"],channelOverwriteDelete:["حذف صلاحيات قناة","Channel permissions removed"],channelPositionUpdate:["تغيير ترتيب القنوات","Channel position changed"],
 guildUpdate:["تعديل إعدادات السيرفر","Server settings updated"],
 auditLogOther:["أحداث Audit Log غير المصنفة","Unclassified audit event"]
};
const auditLabels={
 inviteCreate:["إنشاء دعوة","Invite created"],inviteUpdate:["تعديل دعوة","Invite updated"],inviteDelete:["حذف دعوة","Invite deleted"],
 webhookCreate:["إنشاء Webhook","Webhook created"],webhookUpdate:["تعديل Webhook","Webhook updated"],webhookDelete:["حذف Webhook","Webhook deleted"],
 emojiCreate:["إضافة Emoji","Emoji created"],emojiUpdate:["تعديل Emoji","Emoji updated"],emojiDelete:["حذف Emoji","Emoji deleted"],
 integrationCreate:["إضافة تكامل","Integration created"],integrationUpdate:["تعديل تكامل","Integration updated"],integrationDelete:["حذف تكامل","Integration deleted"],
 stageInstanceCreate:["إنشاء Stage","Stage created"],stageInstanceUpdate:["تعديل Stage","Stage updated"],stageInstanceDelete:["حذف Stage","Stage deleted"],
 stickerCreate:["إضافة ملصق","Sticker created"],stickerUpdate:["تعديل ملصق","Sticker updated"],stickerDelete:["حذف ملصق","Sticker deleted"],
 guildScheduledEventCreate:["إنشاء فعالية","Scheduled event created"],guildScheduledEventUpdate:["تعديل فعالية","Scheduled event updated"],guildScheduledEventDelete:["حذف فعالية","Scheduled event deleted"],
 threadCreate:["إنشاء Thread","Thread created"],threadUpdate:["تعديل Thread","Thread updated"],threadDelete:["حذف Thread","Thread deleted"],
 applicationCommandPermissionUpdate:["تعديل صلاحيات أوامر التطبيقات","Application command permissions updated"],
 soundboardSoundCreate:["إضافة صوت Soundboard","Soundboard sound created"],soundboardSoundUpdate:["تعديل صوت Soundboard","Soundboard sound updated"],soundboardSoundDelete:["حذف صوت Soundboard","Soundboard sound deleted"],
 autoModerationRuleCreate:["إنشاء قاعدة AutoMod","AutoMod rule created"],autoModerationRuleUpdate:["تعديل قاعدة AutoMod","AutoMod rule updated"],autoModerationRuleDelete:["حذف قاعدة AutoMod","AutoMod rule deleted"],autoModerationBlockMessage:["AutoMod منع رسالة","AutoMod blocked a message"],autoModerationFlagToChannel:["AutoMod أرسل تنبيهًا","AutoMod flagged a message"],autoModerationUserCommunicationDisabled:["AutoMod قيّد عضوًا","AutoMod timed out a member"],autoModerationQuarantineUser:["AutoMod عزل عضوًا","AutoMod quarantined a member"],
 creatorMonetizationRequestCreated:["طلب Creator Monetization","Creator monetization request"],creatorMonetizationTermsAccepted:["قبول شروط Creator Monetization","Creator terms accepted"],
 onboardingPromptCreate:["إنشاء سؤال Onboarding","Onboarding prompt created"],onboardingPromptUpdate:["تعديل سؤال Onboarding","Onboarding prompt updated"],onboardingPromptDelete:["حذف سؤال Onboarding","Onboarding prompt deleted"],onboardingCreate:["إنشاء Onboarding","Onboarding created"],onboardingUpdate:["تعديل Onboarding","Onboarding updated"],
 homeSettingsCreate:["إنشاء Home Settings","Home settings created"],homeSettingsUpdate:["تعديل Home Settings","Home settings updated"],voiceChannelStatusCreate:["تعيين حالة روم صوتي","Voice channel status set"],voiceChannelStatusDelete:["إزالة حالة روم صوتي","Voice channel status removed"]
};
Object.assign(LOG_EVENT_LABELS,Object.fromEntries(Object.entries(auditLabels)));
const LOGGING_DEFAULTS={
 enabled:true,defaultChannelId:"1561771014977753268",
 categories:Object.fromEntries(LOG_CATEGORY_UI.map(item=>[item.id,{enabled:true,channelId:""}])),
 events:Object.fromEntries(Object.keys(LOG_EVENT_LABELS).map(key=>[key,true]))
};
const WELCOME_DEFAULTS={enabled:false,channelId:"",message:"",imageUrl:"",goodbyeEnabled:false,goodbyeChannelId:"",goodbyeMessage:""};
function botControlData(){
 const source=state.data?.botControl||{};
 const logging=source.logging||{};
 const welcome=source.welcome||{};
 return {
  logging:{...LOGGING_DEFAULTS,...logging,categories:{...LOGGING_DEFAULTS.categories,...(logging.categories||{})},events:{...LOGGING_DEFAULTS.events,...(logging.events||{})}},
  welcome:{...WELCOME_DEFAULTS,...welcome}
 };
}
function channelControl(name,current,channels,placeholder){
 const available=(channels||[]).filter(channel=>[0,5].includes(Number(channel.type)));
 if(available.length){
  return '<select name="'+name+'"><option value="">'+t("استخدم الروم الافتراضي","Use default channel")+'</option>'+
   available.map(channel=>'<option value="'+esc(channel.id)+'"'+(String(current||"")===String(channel.id)?" selected":"")+'># '+esc(channel.name)+'</option>').join("")+'</select>';
 }
 return '<input name="'+name+'" inputmode="numeric" pattern="[0-9]{15,22}" value="'+esc(current||"")+'" placeholder="'+esc(placeholder||"Discord Channel ID")+'">';
}
function renderLogs(data){
 const control=botControlData(),logging=control.logging,channels=data.channels||[];
 const eventFields=LOG_CATEGORY_UI.map(category=>{
  const current=logging.categories[category.id]||{enabled:true,channelId:""};
  const events=category.events.map(eventKey=>{
   const label=LOG_EVENT_LABELS[eventKey]||[eventKey,eventKey];
   return '<label class="log-event"><input type="checkbox" data-log-event="'+eventKey+'"'+(logging.events[eventKey]!==false?" checked":"")+'><span>'+t(label[0],label[1])+'</span></label>';
  }).join("");
  return '<section class="panel"><div class="panel-head"><div><h2>'+t(category.title[0],category.title[1])+'</h2><div class="muted">'+t(category.description[0],category.description[1])+'</div></div>'+
   '<label class="checkline"><input class="switch" type="checkbox" data-log-category="'+category.id+'"'+(current.enabled!==false?" checked":"")+'><span>'+t("القسم مفعّل","Category enabled")+'</span></label></div>'+
   '<div class="panel-body"><div class="log-category"><div class="log-event-grid">'+events+'</div><div class="field"><label>'+t("روم استقبال هذا القسم","Destination channel for this category")+'</label>'+channelControl("channel_"+category.id,current.channelId,channels,"أدخل ID الروم أو اتركه فارغًا")+'<div class="muted">'+t("اتركه فارغًا لاستخدام الروم الافتراضي.","Leave blank to use the default log channel.")+'</div></div></div></div></section>';
 }).join("");
 $("#mainView").innerHTML=
  head(t("إدارة اللوجات","Log management"),t("تحكم في تسجيل كل حدث داخل Discord، وحدد قناة مستقلة لكل مجموعة. التغييرات تُحفظ وتصل إلى البوت تلقائيًا.","Control each Discord event and route categories to separate channels. Changes are saved and picked up by the running bot."))+
  '<form id="logSettingsForm">'+
   '<section class="panel"><div class="panel-head"><div><h2>'+t("التحكم الرئيسي","Master logging control")+'</h2><div class="muted">'+t("إيقاف هذا المفتاح يوقف كل اللوجات فورًا، مع الاحتفاظ بباقي اختياراتك.","Turning this off pauses all log delivery while keeping your saved selections.")+'</div></div>'+
    '<label class="checkline"><input class="switch" name="globalEnabled" type="checkbox"'+(logging.enabled!==false?" checked":"")+'><span>'+t("تشغيل نظام اللوجات بالكامل","Enable all server logs")+'</span></label></div>'+
    '<div class="panel-body"><div class="field"><label>'+t("الروم الافتراضي","Default log channel")+'</label>'+channelControl("defaultChannelId",logging.defaultChannelId,channels,"1561771014977753268")+'<div class="muted">'+t("أي قسم ليس له روم خاص سيستخدم هذا الروم. لو قائمة الرومات فارغة، أدخل Discord Channel ID يدويًا.","Categories without a dedicated channel use this one. If channels are unavailable, enter the Discord Channel ID manually.")+'</div></div>'+
    '<div class="settings-actions"><button class="btn primary" type="submit">'+t("حفظ إعدادات اللوجات","Save log settings")+'</button><button class="btn" type="button" id="testLogButton">'+t("إرسال Log تجريبي","Send test log")+'</button><span class="status-note" id="logSettingsStatus">'+t("آخر مزامنة عند حفظ الإعدادات. البوت يلتقط التغييرات خلال 15 ثانية.","On save, the bot picks up changes within 15 seconds.")+'</span></div></div></section>'+
   '<div class="view-head"><div><h1>'+t("إعدادات كل نوع","Per-category controls")+'</h1><p>'+t("أوقف حدثًا منفردًا أو عطّل المجموعة بالكامل، واختر رومًا مختلفًا لها.","Disable an individual event or an entire category, and choose a different destination channel.")+'</p></div></div>'+
   eventFields+
  '</form>'+
  '<div class="notice">'+t("حالة تشغيل اللوجات لا توقف أو تحذف أي رسائل في Discord؛ هي تتحكم فقط في الأحداث التي يسجلها بوت S.W.A.T. REDLINE من الآن فصاعدًا.","Logging controls do not delete Discord messages. They only enable or pause future event reporting by the S.W.A.T. REDLINE bot.")+'</div>';
 $("#logSettingsForm").addEventListener("submit",async event=>{
  event.preventDefault();
  const form=event.currentTarget;
  const loggingPayload={enabled:form.elements.globalEnabled.checked,defaultChannelId:String(new FormData(form).get("defaultChannelId")||"").trim(),categories:{},events:{}};
  for(const category of LOG_CATEGORY_UI){
   const categoryToggle=$('[data-log-category="'+category.id+'"]',form);
   loggingPayload.categories[category.id]={enabled:Boolean(categoryToggle?.checked),channelId:String(new FormData(form).get("channel_"+category.id)||"").trim()};
   for(const eventKey of category.events)loggingPayload.events[eventKey]=Boolean($('[data-log-event="'+eventKey+'"]',form)?.checked);
  }
  const payload={logging:loggingPayload,welcome:control.welcome};
  const status=$("#logSettingsStatus");
  status.textContent=t("جاري حفظ الإعدادات...","Saving settings...");
  try{
   const response=await post({action:"save_bot_settings",settings:payload});
   state.data.botControl=response.botControl;
   status.textContent=t("تم الحفظ. البوت سيطبق التغييرات خلال 15 ثانية.","Saved. The bot will apply changes within 15 seconds.");
   toast(t("تم حفظ إعدادات اللوجات.","Log settings saved."));
   render();
  }catch(error){status.textContent=t("فشل الحفظ: ","Save failed: ")+error.message;toast(error.message);}
 });
 $("#testLogButton").addEventListener("click",async()=>{
  const form=$("#logSettingsForm");
  const channelId=String(new FormData(form).get("defaultChannelId")||"").trim();
  const status=$("#logSettingsStatus");
  if(!channelId){toast(t("أدخل الروم الافتراضي أولًا.","Enter the default channel first."));return;}
  if(!confirm(t("إرسال رسالة اختبار إلى روم اللوجات؟","Send a test message to the log channel?")))return;
  status.textContent=t("جاري إرسال الاختبار...","Sending test...");
  try{
   const response=await post({action:"test_log",channelId});
   status.textContent=t("وصل اختبار إلى #"+response.channelName,"Test delivered to #"+response.channelName);
   toast(t("تم إرسال اللوج التجريبي.","Test log sent."));
  }catch(error){status.textContent=t("فشل الاختبار: ","Test failed: ")+error.message;toast(error.message);}
 });
}
function renderWelcome(data){
 const control=botControlData(),welcome=control.welcome,channels=(data.channels||[]).filter(channel=>[0,5].includes(Number(channel.type)));
 $("#mainView").innerHTML=
  head(t("الترحيب والمغادرة","Welcome & goodbye"),t("جهّز إعدادات دخول وخروج الأعضاء. اترك النظام متوقفًا إلى أن تنتهي من صورة الترحيب والنصوص النهائية.","Prepare member join and leave messages. Keep these systems disabled until your welcome artwork and final copy are ready."))+
  '<div class="notice">'+t("هنسيب الصورة والتصميم النهائي لك. تقدر تحفظ الإعدادات الآن وتبقي معطلة، ثم تضيف صورة الترحيب والنصوص النهائية لاحقًا من نفس الصفحة.","The artwork and final copy remain yours to provide. You can save the settings now and leave them disabled, then add your final image and text here later.")+'</div>'+
  '<form id="welcomeSettingsForm"><section class="panel"><div class="panel-head"><div><h2>'+t("رسالة الترحيب","Welcome message")+'</h2><div class="muted">'+t("تظهر عند انضمام عضو جديد إلى السيرفر.","Sent when a member joins your server.")+'</div></div>'+
   '<label class="checkline"><input class="switch" name="enabled" type="checkbox"'+(welcome.enabled?" checked":"")+'><span>'+t("مفعّل","Enabled")+'</span></label></div>'+
   '<div class="panel-body"><div class="field"><label>'+t("روم الترحيب","Welcome channel")+'</label>'+channelControl("channelId",welcome.channelId,channels,"Discord Channel ID")+'</div>'+
   '<div class="field"><label>'+t("نص الترحيب","Welcome text")+'</label><textarea name="message" maxlength="1800" placeholder="'+t("اكتب رسالة الترحيب النهائية بعد تجهيزها...","Add your final welcome message when it is ready...")+'">'+esc(welcome.message)+'</textarea></div>'+
   '<div class="field"><label>'+t("رابط صورة الترحيب (اختياري)","Welcome image URL (optional)")+'</label><input name="imageUrl" type="url" maxlength="2048" value="'+esc(welcome.imageUrl)+'" placeholder="https://..."></div>'+
   '<div class="muted">'+t("المتغيرات المتاحة: {{user}} لذكر العضو، {{username}} للاسم، {{server}} لاسم السيرفر، {{memberCount}} لعدد الأعضاء.","Available tokens: {{user}}, {{username}}, {{server}}, {{memberCount}}.")+'</div></div></section>'+
  '<section class="panel"><div class="panel-head"><div><h2>'+t("رسالة المغادرة","Goodbye message")+'</h2><div class="muted">'+t("تظهر عند مغادرة عضو للسيرفر.","Sent when a member leaves your server.")+'</div></div>'+
   '<label class="checkline"><input class="switch" name="goodbyeEnabled" type="checkbox"'+(welcome.goodbyeEnabled?" checked":"")+'><span>'+t("مفعّل","Enabled")+'</span></label></div>'+
   '<div class="panel-body"><div class="field"><label>'+t("روم المغادرة","Goodbye channel")+'</label>'+channelControl("goodbyeChannelId",welcome.goodbyeChannelId,channels,"Discord Channel ID")+'</div>'+
   '<div class="field"><label>'+t("نص المغادرة","Goodbye text")+'</label><textarea name="goodbyeMessage" maxlength="1800" placeholder="'+t("اكتب رسالة المغادرة التي تريدها لاحقًا...","Add your final goodbye message later...")+'">'+esc(welcome.goodbyeMessage)+'</textarea></div></div></section>'+
   '<div class="settings-actions"><button class="btn primary" type="submit">'+t("حفظ إعدادات الترحيب","Save welcome settings")+'</button><span class="status-note" id="welcomeSettingsStatus">'+t("النظامان متوقفان افتراضيًا إلى أن تجهز الرسائل.","Both systems are disabled by default until the messages are ready.")+'</span></div></form>';
 $("#welcomeSettingsForm").addEventListener("submit",async event=>{
  event.preventDefault();const form=event.currentTarget,values=new FormData(form);
  const payload={
   enabled:form.elements.enabled.checked,
   channelId:String(values.get("channelId")||"").trim(),
   message:String(values.get("message")||"").trim(),
   imageUrl:String(values.get("imageUrl")||"").trim(),
   goodbyeEnabled:form.elements.goodbyeEnabled.checked,
   goodbyeChannelId:String(values.get("goodbyeChannelId")||"").trim(),
   goodbyeMessage:String(values.get("goodbyeMessage")||"").trim()
  };
  const status=$("#welcomeSettingsStatus");status.textContent=t("جاري حفظ الإعدادات...","Saving settings...");
  try{
   const response=await post({action:"save_bot_settings",settings:{logging:control.logging,welcome:payload}});
   state.data.botControl=response.botControl;
   status.textContent=t("تم حفظ الإعدادات. الترحيب سيبقى متوقفًا حتى تفعّله.","Settings saved. Welcome remains disabled until you enable it.");
   toast(t("تم حفظ إعدادات الترحيب والمغادرة.","Welcome and goodbye settings saved."));
   render();
  }catch(error){status.textContent=t("فشل الحفظ: ","Save failed: ")+error.message;toast(error.message);}
 });
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
 $("#languageButton").addEventListener("click",()=>{state.lang=ar()?"en":"ar";document.documentElement.lang=state.lang;document.documentElement.dir=ar()?"rtl":"ltr";$("#languageButton").textContent=ar()?"EN":"عربي";$$("[data-view]").forEach(button=>{const labels={overview:["نظرة عامة","Overview"],server:["السيرفر والرتب","Server & roles"],messages:["الرسائل والإعلانات","Messages & announcements"],moderation:["الإشراف والعقوبات","Moderation"],integrations:["التكاملات الخارجية","Integrations"],logs:["إدارة اللوجات","Log management"],welcome:["الترحيب والمغادرة","Welcome & goodbye"],modules:["حالة الأنظمة","System modules"]};const item=labels[button.dataset.view];button.lastChild.textContent=ar()?item[0]:item[1];});render();});
 $("#backButton").addEventListener("click",()=>window.parent.postMessage({type:"swat-bot-command-center-close"},location.origin));
 load();
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init,{once:true});else init();
})();