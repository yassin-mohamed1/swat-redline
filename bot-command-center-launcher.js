(() => {
  "use strict";
  function install(){
    const nav=document.getElementById("nav");
    const settings=document.getElementById("settingsNav");
    if(!nav||!settings||document.getElementById("botCenterNav"))return;
    const button=document.createElement("button");
    button.type="button";
    button.id="botCenterNav";
    button.innerHTML='<span class="ico">◈</span> لوحة تحكم البوت';
    button.style.display="none";
    button.addEventListener("click",open);
    nav.insertBefore(button,settings);
    const sync=()=>{button.style.display=getComputedStyle(settings).display==="none"?"none":"flex";};
    new MutationObserver(sync).observe(settings,{attributes:true,attributeFilter:["style","class"]});
    sync();
  }
  function open(){
    if(typeof currentCanAdmin!=="undefined"&&!currentCanAdmin)return;
    if(document.getElementById("botCenterFrame"))return;
    const frame=document.createElement("iframe");
    frame.id="botCenterFrame";
    frame.title="S.W.A.T. REDLINE Bot Command Center";
    frame.src="/bot-command-center.html";
    frame.allow="clipboard-read; clipboard-write";
    frame.style.cssText="position:fixed;inset:0;width:100vw;height:100dvh;border:0;background:#080c12;z-index:100000";
    document.body.appendChild(frame);
    document.documentElement.style.overflow="hidden";
    document.body.style.overflow="hidden";
  }
  function close(){
    document.getElementById("botCenterFrame")?.remove();
    document.documentElement.style.overflow="";
    document.body.style.overflow="";
  }
  window.addEventListener("message",event=>{
    if(event.origin!==location.origin||event.data?.type!=="swat-bot-command-center-close")return;
    close();
  });
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",install,{once:true});else install();
  window.SWATBotCommandCenterLauncher={open,close};
})();