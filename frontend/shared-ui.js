/**
 * CHM Finance — Shared UI components for all internal pages
 * Theme toggle, Language toggle, Notifications panel
 * Include this after app.js on any page
 */

// ═══ THEME ═══
(function initTheme(){
  if(localStorage.getItem('chm_theme')==='light')document.documentElement.classList.add('light');
  document.querySelectorAll('[data-theme-toggle]').forEach(btn=>{
    if(document.documentElement.classList.contains('light'))btn.textContent='☀️';
  });
})();

function togglePageTheme(btn){
  document.documentElement.classList.toggle('light');
  const isLight=document.documentElement.classList.contains('light');
  localStorage.setItem('chm_theme',isLight?'light':'dark');
  btn.textContent=isLight?'☀️':'🌙';
}

// ═══ LANGUAGE ═══
let pageLang=localStorage.getItem('chm_lang')||'ru';

const SIDEBAR_TR={
  ru:{Дашборд:'Дашборд',Боты:'Боты',Сигналы:'Сигналы',Бэктесты:'Бэктесты',Биржи:'Биржи',Настройки:'Настройки',Академия:'Академия',Выйти:'Выйти'},
  en:{Дашборд:'Dashboard',Боты:'Bots',Сигналы:'Signals',Бэктесты:'Backtests',Биржи:'Exchanges',Настройки:'Settings',Академия:'Academy',Выйти:'Logout'}
};

function togglePageLang(btn){
  pageLang=pageLang==='ru'?'en':'ru';
  localStorage.setItem('chm_lang',pageLang);
  btn.textContent=pageLang==='ru'?'EN':'RU';
  applyPageLang();
}

function applyPageLang(){
  const tr=SIDEBAR_TR[pageLang];
  document.querySelectorAll('.sidebar-link').forEach(el=>{
    const svg=el.querySelector('svg');
    const txt=el.textContent.trim();
    Object.entries(SIDEBAR_TR.ru).forEach(([ruK])=>{
      if(txt===ruK||txt===SIDEBAR_TR.en[ruK]){
        if(svg){el.innerHTML='';el.appendChild(svg);el.appendChild(document.createTextNode(tr[ruK]))}
        else el.textContent=tr[ruK];
      }
    });
  });
  // Translate notification panel
  const en=pageLang==='en';
  document.querySelectorAll('#pageNotifPanel span[style*="font-weight:600"]').forEach(el=>{el.textContent=en?'Notifications':'Уведомления'});
  document.querySelectorAll('#pageNotifPanel button[onclick*="clearPageNotifs"]').forEach(el=>{el.textContent=en?'Clear':'Очистить'});
  const empty=document.querySelector('#pageNotifList > div[style*="text-align:center"]');
  if(empty&&(empty.textContent.includes('Нет уведомлений')||empty.textContent.includes('No notifications')))empty.textContent=en?'No notifications':'Нет уведомлений';
}

(function initLang(){
  if(pageLang==='en')setTimeout(applyPageLang,200);
})();

// ═══ NOTIFICATIONS ═══
const pageNotifs=[];

function togglePageNotif(){
  document.getElementById('pageNotifPanel')?.classList.toggle('open');
}

function addPageNotif(type,text){
  pageNotifs.unshift({type,text,time:new Date()});
  if(pageNotifs.length>20)pageNotifs.pop();
  renderPageNotifs();
}

function clearPageNotifs(){
  pageNotifs.length=0;
  renderPageNotifs();
  const dot=document.getElementById('pageNotifDot');
  if(dot)dot.style.display='none';
}

function renderPageNotifs(){
  const el=document.getElementById('pageNotifList');
  if(!el)return;
  const dot=document.getElementById('pageNotifDot');
  if(!pageNotifs.length){
    el.innerHTML='<div style="text-align:center;padding:24px;color:#64748b;font-size:.8rem">Нет уведомлений</div>';
    if(dot)dot.style.display='none';
    return;
  }
  const colors={signal:'#818CF8',trade:'#10b981',system:'#f59e0b',error:'#ef4444'};
  el.innerHTML=pageNotifs.map(n=>`<div style="display:flex;gap:10px;padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.04)"><div style="width:6px;height:6px;border-radius:50%;background:${colors[n.type]||'#64748b'};margin-top:6px;flex-shrink:0"></div><div style="flex:1"><div style="font-size:.85rem">${n.text}</div><div style="font-size:.7rem;color:#64748b;margin-top:2px">${Utils.timeAgo(n.time)}</div></div></div>`).join('');
  if(dot)dot.style.display='';
}

// Keyboard shortcuts
document.addEventListener('keydown',e=>{
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA'||e.target.tagName==='SELECT')return;
  const key=e.key.toLowerCase();
  if(e.altKey){
    if(key==='d')location.href='/dashboard.html';
    if(key==='b')location.href='/bots.html';
    if(key==='s')location.href='/signals.html';
    if(key==='t')location.href='/backtests.html';
    if(key==='e')location.href='/wallet.html';
    if(key==='a')location.href='/academy/';
  }
  if(key==='escape'){
    document.querySelectorAll('.modal-bg').forEach(m=>m.classList.remove('active'));
    document.querySelectorAll('[style*="display:flex"][id*="Modal"],[style*="display: flex"][id*="Modal"]').forEach(m=>m.style.display='none');
  }
});

// Mobile sidebar toggle
document.addEventListener('DOMContentLoaded',()=>{
  const toggle=document.getElementById('sidebar-toggle');
  const sidebar=document.querySelector('.sidebar');
  if(toggle&&sidebar){
    toggle.addEventListener('click',()=>sidebar.classList.toggle('open'));
    document.addEventListener('click',e=>{
      if(window.innerWidth<=1024&&sidebar.classList.contains('open')&&!sidebar.contains(e.target)&&!toggle.contains(e.target)){
        sidebar.classList.remove('open');
      }
    });
  }
});

// Global loading indicator
let loadingCount=0;
const loadingBar=document.createElement('div');
loadingBar.style.cssText='position:fixed;top:0;left:0;height:2px;background:linear-gradient(90deg,#C850C0,#FF6B35);z-index:9999;transition:width .3s;width:0';
document.body.appendChild(loadingBar);
window.showLoading=()=>{loadingCount++;loadingBar.style.width='70%'};
window.hideLoading=()=>{loadingCount=Math.max(0,loadingCount-1);if(!loadingCount){loadingBar.style.width='100%';setTimeout(()=>{loadingBar.style.width='0'},300)}};

// Close notif on outside click
document.addEventListener('click',e=>{
  const wrap=document.getElementById('pageNotifWrap');
  if(wrap&&!wrap.contains(e.target)){
    document.getElementById('pageNotifPanel')?.classList.remove('open');
  }
});

// ═══ SCROLL TO TOP ═══
(function initScrollTop(){
  const btn=document.createElement('button');
  btn.id='scrollTopBtn';
  btn.innerHTML='<svg width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>';
  btn.style.cssText='position:fixed;bottom:24px;right:24px;width:40px;height:40px;border-radius:12px;background:rgba(255,140,0,.9);color:#fff;border:none;cursor:pointer;display:none;align-items:center;justify-content:center;z-index:90;box-shadow:0 4px 16px rgba(255,140,0,.3);transition:opacity .2s,transform .2s;backdrop-filter:blur(8px)';
  btn.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
  document.body.appendChild(btn);
  const main=document.querySelector('.main-content');
  if(main){
    main.addEventListener('scroll',()=>{btn.style.display=main.scrollTop>300?'flex':'none'});
  }
  window.addEventListener('scroll',()=>{btn.style.display=window.scrollY>300?'flex':'none'});
})();

// ═══ CONNECTION STATUS INDICATOR ═══
(function initConnStatus(){
  const dot=document.createElement('div');
  dot.id='connDot';
  dot.title='Server status';
  dot.style.cssText='width:8px;height:8px;border-radius:50%;background:#64748b;flex-shrink:0;transition:background .3s';
  const wrap=document.querySelector('.topbar-actions');
  if(wrap)wrap.insertBefore(dot,wrap.firstChild);
  function check(){
    fetch('/api/health',{method:'GET'}).then(r=>{if(r.ok){dot.style.background='#10b981';dot.title='Server: online'}else throw 0}).catch(()=>{dot.style.background='#ef4444';dot.title='Server: offline'});
  }
  check();setInterval(check,30000);
})();

// ═══ SESSION TIMER (all pages) ═══
(function initSessionTimerShared(){
  const el=document.getElementById('sessionTimer');
  if(!el)return; // only if page has the element
  const start=Date.now();
  function tick(){
    const s=Math.floor((Date.now()-start)/1000);
    const m=Math.floor(s/60),h=Math.floor(m/60);
    el.textContent=(h?String(h).padStart(2,'0')+':':'')+String(m%60).padStart(2,'0')+':'+String(s%60).padStart(2,'0');
  }
  tick();setInterval(tick,1000);
})();
