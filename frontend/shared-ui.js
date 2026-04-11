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

// Close notif on outside click
document.addEventListener('click',e=>{
  const wrap=document.getElementById('pageNotifWrap');
  if(wrap&&!wrap.contains(e.target)){
    document.getElementById('pageNotifPanel')?.classList.remove('open');
  }
});
