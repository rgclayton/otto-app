(function(){
  "use strict";

  // ---------- storage adapter: file (File System Access) → window.storage → localStorage → memory ----------
  var mem = {};
  var store = {
    async get(k){
      try{ if(window.storage){ var r = await window.storage.get(k); return r ? r.value : null; } }catch(e){ return null; }
      try{ if(window.localStorage) return localStorage.getItem(k); }catch(e){}
      return k in mem ? mem[k] : null;
    },
    async set(k,v){
      try{ if(window.storage){ await window.storage.set(k,v); return; } }catch(e){}
      try{ if(window.localStorage){ localStorage.setItem(k,v); return; } }catch(e){}
      mem[k]=v;
    }
  };
  var KEY = "deck:state:v2";

  // ---------- file link (otto-data.json via File System Access API) ----------
  var fileHandle = null;                     // bound FileSystemFileHandle when linked
  var fsSupported = !!(window.showOpenFilePicker && window.indexedDB);
  function idb(mode,fn){
    return new Promise(function(res,rej){
      var op=indexedDB.open("otto-fs",1);
      op.onupgradeneeded=function(){ op.result.createObjectStore("kv"); };
      op.onerror=function(){ rej(op.error); };
      op.onsuccess=function(){
        var db=op.result, tx=db.transaction("kv",mode), st=tx.objectStore("kv");
        var r=fn(st); tx.oncomplete=function(){ res(r&&r.result); }; tx.onerror=function(){ rej(tx.error); };
      };
    });
  }
  function idbGetHandle(){ return idb("readonly",function(st){ return st.get("handle"); }); }
  function idbSetHandle(h){ return idb("readwrite",function(st){ return st.put(h,"handle"); }); }
  function idbClearHandle(){ return idb("readwrite",function(st){ return st.delete("handle"); }); }
  async function fileReadState(h){
    var f=await h.getFile(); var t=await f.text();
    return t.trim() ? JSON.parse(t) : null;
  }
  async function fileWriteState(h){
    var w=await h.createWritable(); await w.write(JSON.stringify(state,null,2)); await w.close();
  }
  async function ensurePermission(h,request){
    if(!h.queryPermission) return true;
    var opts={mode:"readwrite"};
    if(await h.queryPermission(opts)==="granted") return true;
    if(request && await h.requestPermission(opts)==="granted") return true;
    return false;
  }

  // ---------- state ----------
  var state = {
    tasks: [],
    loops: [],
    pending: [],
    rejected: [],
    meetings: [],
    meetingHours: {},
    settings: { budget: 15, dailyHours: 8, manualStatus: "auto", theme: "auto", reviewMode: true, collapsed: {}, userName: "" },
    meta: { lastRun: null, processedSourceIds: [], feedback: [], missed: [] }
  };
  var saveTimer=null;
  function persist(){
    clearTimeout(saveTimer);
    saveTimer=setTimeout(function(){
      if(fileHandle){ fileWriteState(fileHandle).catch(function(){ toast("Couldn't write to the linked file"); }); }
      else { store.set(KEY, JSON.stringify(state)); }
    }, 250);
  }
  function uid(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

  var seed = {
    tasks:[],
    loops:[],
    pending:[],
    rejected:[],
    meetings:[],
    meetingHours:{},
    settings:{ budget:15, dailyHours:8, manualStatus:"auto", theme:"auto", reviewMode:true, collapsed:{}, userName:"" },
    meta:{ lastRun:null, processedSourceIds:[], feedback:[], missed:[] }
  };

  // ---------- constants ----------
  var DAYS = [["mon","Mon"],["tue","Tue"],["wed","Wed"],["thu","Thu"],["fri","Fri"]];
  var EFF_LABEL = {1:"S",2:"M",3:"L"};
  var EFF_HOURS = {1:1,2:2,3:4};              // S=1h, M=2h, L=4h
  var WEEK_BUCKETS = ["today","mon","tue","wed","thu","fri"];

  // ---------- capacity (daily, hours-based) ----------
  function fmtH(h){ return (Math.round(h*10)/10).toString(); }
  function isoDate(d){
    d = d || new Date();
    var m=String(d.getMonth()+1).padStart(2,"0"), day=String(d.getDate()).padStart(2,"0");
    return d.getFullYear()+"-"+m+"-"+day;
  }
  function meetingHoursFor(dateStr){
    var v = state.meetingHours && state.meetingHours[dateStr];
    return (typeof v==="number" && v>=0) ? v : 0;
  }
  function taskHoursForBucket(bucket){
    return state.tasks.reduce(function(s,t){
      if(!t.done && t.bucket===bucket) return s + (EFF_HOURS[t.eff]||1);
      return s;
    },0);
  }
  // "today" = the abstract today bucket AND the current weekday bucket, unified
  function isTodayBucket(bucket){ return bucket==="today" || bucket===todayKey(); }
  function todayTaskHours(){
    return state.tasks.reduce(function(s,t){
      if(!t.done && isTodayBucket(t.bucket)) return s + (EFF_HOURS[t.eff]||1);
      return s;
    },0);
  }
  function dailyCeiling(){ return Math.max(1, state.settings.dailyHours||8); }
  function committedHoursToday(){ return meetingHoursFor(isoDate()) + todayTaskHours(); }

  function autoStatus(pct){
    if(pct < 0.55) return "room";
    if(pct < 0.8)  return "ok";
    if(pct <= 1.0) return "full";
    return "over";
  }
  var STATUS_META = {
    room:{label:"Room for more",color:"var(--load-1)"},
    ok:  {label:"About right",  color:"var(--load-2)"},
    full:{label:"At capacity",  color:"var(--load-3)"},
    over:{label:"Overloaded",   color:"var(--load-4)"}
  };
  function effectiveStatus(){
    var pct = committedHoursToday() / dailyCeiling();
    var s = state.settings.manualStatus;
    return (s && s!=="auto") ? s : autoStatus(pct);
  }

  function renderGauge(){
    var mtg = meetingHoursFor(isoDate());
    var taskH = todayTaskHours();
    var committed = mtg + taskH;
    var ceiling = dailyCeiling();
    var pct = committed/ceiling;
    var meta = STATUS_META[effectiveStatus()];
    var el = document.getElementById("gaugeFill");
    el.style.width = (Math.min(1,pct)*100)+"%";
    el.style.background = meta.color;
    document.getElementById("gaugeStatus").textContent = meta.label;
    document.getElementById("gaugeStatus").style.color = meta.color;
    var free = ceiling - committed;
    var tail = pct>1 ? " · "+fmtH(-free)+"h over" : " · "+fmtH(free)+"h free";
    document.getElementById("gaugeSub").textContent = fmtH(committed)+"h / "+fmtH(ceiling)+"h today"+tail;
    // panel detail
    document.getElementById("d-committed").textContent = fmtH(committed);
    document.getElementById("d-budget").textContent = fmtH(ceiling);
    document.getElementById("d-breakdown").textContent = fmtH(mtg)+"h meetings · "+fmtH(taskH)+"h tasks";
    var dl = document.getElementById("d-label");
    dl.textContent = meta.label + (state.settings.manualStatus!=="auto" ? " (set manually)" : "");
    dl.style.color = meta.color;
  }

  function buildBlurb(){
    var s = effectiveStatus();
    var mtg = meetingHoursFor(isoDate());
    var taskH = todayTaskHours();
    var free = dailyCeiling() - (mtg+taskH);
    var active = state.tasks.filter(function(t){ return !t.done && isTodayBucket(t.bucket); });
    active.sort(function(a,b){ return (EFF_HOURS[b.eff]||1)-(EFF_HOURS[a.eff]||1); });
    var top = active.slice(0,3).map(function(t){ return t.title.replace(/\.$/,""); });
    var list = top.length ? top.join(", ") : "a few smaller things";
    var load = fmtH(mtg)+"h of meetings and "+fmtH(taskH)+"h of tasks";
    if(s==="over")  return "I'm over capacity today — "+load+" against a "+fmtH(dailyCeiling())+"h day. I can't take more on right now without something moving. Happy to talk priorities if it's urgent.";
    if(s==="full")  return "I'm fully booked today — "+load+", so I'm out of room. I could pick something up tomorrow, or today if we drop something in exchange.";
    if(s==="ok")    return "My day's about right — "+load+", roughly "+fmtH(free)+"h free. A little room, so flag it if something's a priority: "+list+".";
    return "I've got room today — "+load+", about "+fmtH(free)+"h open. Happy to pick more up, send it my way.";
  }
  function refreshBlurb(){ document.getElementById("blurb").value = buildBlurb(); }

  // ---------- rendering: tasks ----------
  function checkSvg(on){
    return '<span class="check'+(on?' on':'')+'" data-check role="checkbox" aria-checked="'+on+'" tabindex="0"><svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg></span>';
  }
  function dayPicker(t){
    var opts = [["today","today"]].concat(DAYS.map(function(d){return [d[0],d[1].toLowerCase()];})).concat([["later","later"]]);
    return '<select data-move>'+opts.map(function(o){
      return '<option value="'+o[0]+'"'+(t.bucket===o[0]?' selected':'')+'>'+o[1]+'</option>';
    }).join('')+'</select>';
  }
  function domainOf(url){ try{ return new URL(url).hostname.replace(/^www\./,''); }catch(e){ return "source"; } }
  function linkLabel(url){
    try{
      var u=new URL(url), h=u.hostname.replace(/^www\./,'');
      if(/atlassian|jira/.test(h) || /\/browse\//.test(u.pathname)){
        var m=u.pathname.match(/\/browse\/([A-Za-z][A-Za-z0-9]+-\d+)/); return m?("Jira "+m[1]):"Jira";
      }
      if(/github\.com/.test(h)) return "GitHub";
      if(/workfront/.test(h)) return "Workfront";
      if(/outlook|office\.com|office365|owa/.test(h)) return "email";
      if(/slack\.com/.test(h)) return "Slack";
      return h;
    }catch(e){ return "open"; }
  }
  function linkChip(url, prominent){
    return '<a class="tag src-link'+(prominent?' src-primary':'')+'" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer">'+ICON_LINK+esc(linkLabel(url))+'</a>';
  }
  var ICON_LINK='<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>';
  var ICON_EDIT='<svg viewBox="0 0 24 24"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';
  var ICON_DEL='<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
  var ICON_FLAG='<svg viewBox="0 0 24 24"><path d="M5 21V4M5 4h11l-1.5 4L16 12H5"/></svg>';
  var ICON_RESOLVE='<svg viewBox="0 0 24 24"><circle cx="12" cy="6" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18" r="1.6"/></svg>';
  var ICON_SNOOZE='<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  var ICON_WAKE='<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/></svg>';
  // The header's data-file button has its own ICON_SYNC (defined later), so these use distinct names.
  var ICON_PAST='<svg viewBox="0 0 24 24"><path d="M12 8v4l2 2M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/></svg>';
  var ICON_RECENT='<svg viewBox="0 0 24 24"><path d="M12 21V11m0 0 4 4m-4-4-4 4M5 7V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"/></svg>';
  var MISS_SRC=[["slack","Slack"],["email","email"],["teams","Teams"],["other","other"]];
  var SNOOZE_OPTS=[["tomorrow","Tomorrow"],["3days","3 days"],["nextweek","Next week"]];

  function isSnoozed(item){ return item.snoozeUntil && new Date(item.snoozeUntil).getTime()>Date.now(); }
  function snoozeDate(preset){
    var d=new Date(); d.setHours(8,0,0,0);
    if(preset==="tomorrow") d.setDate(d.getDate()+1);
    else if(preset==="3days") d.setDate(d.getDate()+3);
    else if(preset==="nextweek") d.setDate(d.getDate()+((8-d.getDay())%7||7));
    if(d.getTime()<=Date.now()) d.setDate(d.getDate()+1);
    return d.toISOString();
  }
  function snoozeButton(l){
    if(l.done||isSnoozed(l)) return '';
    return '<button class="icon-btn snooze" data-snooze aria-label="Snooze this follow-up" title="Snooze — resurface later">'+ICON_SNOOZE+'</button>';
  }
  function snoozeRow(l){
    if(l.done||isSnoozed(l)) return '';
    return '<div class="flag-src snooze-src" data-snoozerow hidden><span class="rlabel">Resurface when?</span>'
      + SNOOZE_OPTS.map(function(s){ return '<button class="reason-chip" data-snooze-opt="'+s[0]+'">'+s[1]+'</button>'; }).join('')
      + '</div>';
  }
  function snoozeTag(l){
    return isSnoozed(l) ? '<span class="snooze-tag" title="Snoozed">zZ returns '+shortWhen(l.snoozeUntil)+'</span>' : '';
  }

  // false-negative flag: only offered on manually-added items (no scan source)
  function isManual(item){ return !item.source; }
  function flagButton(item){
    if(!isManual(item)) return '';
    return '<button class="icon-btn flag'+(item.missed?' on':'')+'" data-flag aria-label="Flag: the scan should have caught this" title="Scan should have caught this">'+ICON_FLAG+'</button>';
  }
  function flagRow(item){
    if(!isManual(item) || item.missed) return '';
    return '<div class="flag-src" data-flagrow hidden><span class="rlabel">Scan should\u2019ve caught this — where from?</span>'
      + MISS_SRC.map(function(s){ return '<button class="reason-chip" data-flag-src="'+s[0]+'">'+s[1]+'</button>'; }).join('')
      + '</div>';
  }
  function missedTag(item){
    return item.missed ? '<span class="missed-tag" title="Flagged as a scan miss">\u2691 missed · '+esc(item.missed.source)+'</span>' : '';
  }

  // staleness / decay: days-open clock; Later backlog and done items are exempt
  function ageDays(item){ if(!item.created) return 0; return Math.floor((Date.now()-new Date(item.created).getTime())/86400000); }
  function staleLevel(item){
    if(item.done) return null;
    if(item.bucket==="later") return null;   // deliberately deferred → not "stale"
    if(isSnoozed(item)) return null;         // snoozed → deferred on purpose, not stale
    var a=ageDays(item);
    if(a>=14) return "slipped";
    if(a>=5)  return "aging";
    return null;
  }
  function staleTag(item){
    var lvl=staleLevel(item); if(!lvl) return '';
    var a=ageDays(item);
    var glyph = lvl==="slipped" ? "\u26A0" : "\u25F7";
    return '<button class="stale-tag '+lvl+'" data-agereset title="Open '+a+' days — click if you\u2019re still on it (resets the clock)">'+glyph+' '+a+'d</button>';
  }

  // provenance: quiet "why this is here" line, only on scan-captured items
  function shortWhen(iso){
    if(!iso) return '';
    var d=new Date(iso); if(isNaN(d.getTime())) return '';
    var now=new Date();
    if(d.toDateString()===now.toDateString()) return d.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
    if((now-d)/86400000 < 7) return d.toLocaleDateString(undefined,{weekday:"short"});
    return d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
  }
  // provenance shows the full capture date (weekday + month/day, e.g. "Thu, Aug 20") always,
  // unlike shortWhen's relative weekday/time — so you can always see when an item was pulled.
  function captureWhen(iso){
    if(!iso) return '';
    var d=new Date(iso); if(isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
  }
  function provenanceLine(item){
    var s=item.source; if(!s) return '';
    var parts=[];
    var sys=s.system||item.src; if(sys) parts.push(esc(sys));
    if(s.from) parts.push(esc(s.from));
    var w=captureWhen(s.at); if(w) parts.push(w);
    if(!parts.length) return '';
    return '<div class="provenance" title="Where this came from">\u21b3 from '+parts.join(' \u00b7 ')+'</div>';
  }

  function taskCard(t,compact,drag){
    var glow = t.done ? {cls:"",dot:"var(--faint)"} : taskGlow(t.pri);
    var meta='';
    meta += '<span class="tag type">'+t.type+'</span>';
    if(t.area) meta += '<span class="tag area">'+esc(t.area)+'</span>';
    meta += '<span class="tag eff" title="'+EFF_TITLE[t.eff||1]+'">'+EFF_LABEL[t.eff||1]+'</span>';
    if(t.link) meta += linkChip(t.link, !!t.altLink);   // prominent only when a secondary link also exists
    if(t.altLink) meta += linkChip(t.altLink, false);
    meta += missedTag(t);
    meta += staleTag(t);
    meta += resolutionTag(t);

    var editor = '<div class="card-edit" data-editor hidden>'
      + '<div><label>Title</label><input data-e-title value="'+esc(t.title)+'"></div>'
      + '<div><label>TLDR — quick context</label><textarea data-e-note placeholder="One or two lines so you don\'t have to reopen the source every time">'+esc(t.note||"")+'</textarea></div>'
      + '<div><label>Primary link</label><input data-e-link value="'+esc(t.link||"")+'" placeholder="https://…  (ticket, PR, doc)" inputmode="url"></div>'
      + '<div><label>Second link (optional)</label><input data-e-altlink value="'+esc(t.altLink||"")+'" placeholder="https://…  (e.g. the source email)" inputmode="url"></div>'
      + '<div class="edit-actions"><button class="cancel" data-e-cancel>Cancel</button><button class="save" data-e-save>Save</button></div>'
      + '</div>';

    return '<div class="card'+(t.done?' done':(glow.cls?' '+glow.cls:''))+'" data-id="'+t.id+'"'+(drag?' draggable="true"':'')+'>'
      + '<div class="card-row">'
      + checkSvg(t.done)
      + '<div class="card-body"><div class="card-title-row"><div class="card-title">'+esc(t.title)+'</div><span class="tag pri-'+t.pri+'" title="'+PRI_LABEL[t.pri]+'">'+t.pri+'</span></div>'
      + (t.note?'<div class="card-tldr">'+esc(t.note)+'</div>':'')
      + provenanceLine(t)
      + '<div class="card-meta">'+meta+'</div></div>'
      + '<div class="card-actions">'+(compact?'':dayPicker(t))
      + flagButton(t)
      + resolveMenuButton(t)
      + '<button class="icon-btn edit" data-edit aria-label="Edit context">'+ICON_EDIT+'</button>'
      + '<button class="icon-btn" data-del aria-label="Delete">'+ICON_DEL+'</button></div>'
      + '</div>'
      + resolveRow(t)
      + flagRow(t)
      + editor
      + '</div>';
  }

  function renderToday(){
    // capacity strip
    var mtg=meetingHoursFor(isoDate()), taskH=todayTaskHours(), ceiling=dailyCeiling();
    var committed=mtg+taskH, free=ceiling-committed, pct=Math.min(1,committed/ceiling);
    var color=STATUS_META[autoStatus(committed/ceiling)].color;
    document.getElementById("today-cap").innerHTML =
        '<div class="tc-bar"><div class="tc-fill" style="width:'+(pct*100)+'%;background:'+color+'"></div></div>'
      + '<div class="tc-nums"><b>'+fmtH(mtg)+'h</b> meetings · <b>'+fmtH(taskH)+'h</b> tasks · '
      + (free<0 ? '<b style="color:'+color+'">'+fmtH(-free)+'h over</b>' : '<b>'+fmtH(free)+'h</b> free')
      + ' of '+fmtH(ceiling)+'h</div>';

    var el = document.getElementById("today-list");
    var items = state.tasks.filter(function(t){ return isTodayBucket(t.bucket); });
    items.sort(sortTasks);
    if(!items.length){
      el.innerHTML = emptyState("Nothing on today","Add something above, or pull a card in from This week.");
      return;
    }
    var open = items.filter(function(t){return !t.done;});
    var done = items.filter(function(t){return t.done && visibleLocally(t);});
    var html='';
    html += open.map(function(t){return taskCard(t,false);}).join('');
    if(done.length){
      html += collapsibleGroup("today-done","Done",done.length, done.map(function(t){return taskCard(t,false);}).join(''));
    }
    el.innerHTML = html;
  }

  function renderLater(){
    var el = document.getElementById("later-list");
    var items = state.tasks.filter(function(t){ return t.bucket==="later"; });
    items.sort(sortTasks);
    if(!items.length){
      el.innerHTML = emptyState("Backlog's empty","Tasks with no scheduled day show up here.");
      return;
    }
    var open = items.filter(function(t){return !t.done;});
    var done = items.filter(function(t){return t.done && visibleLocally(t);});
    var html = open.map(function(t){return taskCard(t,false);}).join('');
    if(done.length){
      html += collapsibleGroup("later-done","Done",done.length, done.map(function(t){return taskCard(t,false);}).join(''));
    }
    el.innerHTML = html;
  }

  function renderWeek(){
    var grid = document.getElementById("week-grid");
    var wd = weekDates();
    var tKey = todayKey();
    var ceiling = dailyCeiling();
    grid.innerHTML = DAYS.map(function(d){
      var isToday = d[0]===tKey;
      var items = state.tasks.filter(function(t){ return t.bucket===d[0] || (isToday && t.bucket==="today"); });
      items.sort(sortTasks);
      var taskH = items.filter(function(t){return !t.done;}).reduce(function(s,t){return s+(EFF_HOURS[t.eff]||1);},0);
      var cards = items.length ? items.map(function(t){return taskCard(t,false,true);}).join('')
                              : '<div class="day-empty">—</div>';
      var dt = wd[d[0]];
      var dateNum = dt ? dt.getDate() : "";
      var dateKey = dt ? isoDate(dt) : d[0];
      var mtg = meetingHoursFor(dateKey);
      var committed = mtg + taskH;
      var pct = Math.min(1, committed/ceiling);
      var barColor = STATUS_META[autoStatus(committed/ceiling)].color;
      return '<div class="day-col'+(isToday?' is-today':'')+'" data-day="'+d[0]+'">'
        + '<div class="day-top">'
        +   '<div class="day-name">'+d[1]+' <span class="daynum">'+dateNum+'</span>'+(isToday?' <span class="today-pill">today</span>':'')+'</div>'
        +   '<div class="day-bar"><div class="day-fill" style="width:'+(pct*100)+'%;background:'+barColor+'"></div></div>'
        +   '<div class="day-nums"><span class="mtg-wrap">◷ <input class="mtg-input" type="number" min="0" max="24" step="0.5" value="'+fmtH(mtg)+'" data-mtg="'+dateKey+'" aria-label="Meeting hours">h mtg</span>'
        +     '<span class="task-h">'+fmtH(taskH)+'h tasks</span></div>'
        + '</div>'
        + cards + '</div>';
    }).join('');
  }

  function weekDates(){
    var now = new Date();
    var dow = now.getDay();                 // 0 Sun .. 6 Sat
    var monday = new Date(now);
    monday.setDate(now.getDate() + (dow===0 ? -6 : 1-dow));
    var keys = ["mon","tue","wed","thu","fri"], map={};
    for(var i=0;i<5;i++){ var dt=new Date(monday); dt.setDate(monday.getDate()+i); map[keys[i]]=dt; }
    return map;
  }
  function todayKey(){
    return ["sun","mon","tue","wed","thu","fri","sat"][new Date().getDay()];
  }

  function sortTasks(a,b){
    if(a.done!==b.done) return a.done?1:-1;
    var pr={high:0,med:1,low:2};
    if(pr[a.pri]!==pr[b.pri]) return pr[a.pri]-pr[b.pri];
    return (b.eff||1)-(a.eff||1);
  }

  // ---------- rendering: loops ----------
  var SRC_OPTS = [["slack","slack"],["email","email"],["other","other"]];
  var NEEDS_OPTS = [["reply","reply"],["ticket","ticket"],["meeting","meeting"],["feedback","feedback"],["review","review"],["other","other"]];
  function optionsFor(list,cur,prefix){
    return list.map(function(o){
      return '<option value="'+o[0]+'"'+(cur===o[0]?' selected':'')+'>'+(prefix||"")+o[1]+'</option>';
    }).join('');
  }
  function openLabel(src){ return src==="slack"?"Open in Slack":src==="email"?"Open email":"Open link"; }
  function loopCard(l){
    var quiet = l.done || isSnoozed(l);
    var glow = quiet ? {cls:"",dot:"var(--faint)"} : loopGlow(l.needs);
    var srcCls = l.src==="slack"?"src-slack":l.src==="email"?"src-email":"src-other";
    var badge = l.link
      ? '<a class="src-badge '+srcCls+' linked" href="'+esc(l.link)+'" target="_blank" rel="noopener noreferrer" title="Open the conversation">'+l.src+ICON_LINK+'</a>'
      : '<span class="src-badge '+srcCls+'">'+l.src+'</span>';
    var editor = '<div class="card-edit" data-editor hidden>'
      + '<div><label>Source</label><select data-e-src>'+optionsFor(SRC_OPTS,l.src)+'</select></div>'
      + '<div><label>Who / channel</label><input data-e-who value="'+esc(l.who||"")+'" placeholder="e.g. #team-eng or a name"></div>'
      + '<div><label>Summary</label><textarea data-e-summary>'+esc(l.summary)+'</textarea></div>'
      + '<div><label>Needs</label><select data-e-needs>'+optionsFor(NEEDS_OPTS,l.needs,"needs ")+'</select></div>'
      + '<div><label>Link to the conversation</label><input data-e-link value="'+esc(l.link||"")+'" placeholder="Paste the Slack thread / email link" inputmode="url"></div>'
      + '<div class="edit-actions"><button class="cancel" data-e-cancel>Cancel</button><button class="save" data-e-save>Save</button></div>'
      + '</div>';
    return '<div class="loop-card'+(l.done?' done':(isSnoozed(l)?' snoozed':(glow.cls?' '+glow.cls:'')))+'" data-id="'+l.id+'">'
      + '<div class="loop-row">'
      + checkSvg(l.done)
      + badge
      + '<div class="loop-body">'
      + '<div class="card-title-row">'+(l.who?'<div class="loop-who">'+esc(l.who)+'</div>':'')+'<span class="dot" style="background:'+glow.dot+'" title="'+glow.title+'"></span></div>'
      + '<div class="loop-summary">'+esc(l.summary)+'</div>'
      + provenanceLine(l)
      + '<div class="loop-meta"><span class="needs '+l.needs+'" title="'+NEEDS_LABEL[l.needs]+'">needs '+l.needs+'</span>'
      + (l.link?'<a class="tag src-link" href="'+esc(l.link)+'" target="_blank" rel="noopener noreferrer">'+ICON_LINK+openLabel(l.src)+'</a>':'')
      + missedTag(l)
      + staleTag(l)
      + snoozeTag(l)
      + '</div>'
      + '</div>'
      + '<div class="card-actions">'
      + (isSnoozed(l)?'<button class="icon-btn wake" data-wake aria-label="Wake this follow-up now" title="Bring back now">'+ICON_WAKE+'</button>':snoozeButton(l))
      + flagButton(l)
      + '<button class="icon-btn edit" data-edit aria-label="Edit follow-up">'+ICON_EDIT+'</button>'
      + '<button class="icon-btn" data-del aria-label="Delete">'+ICON_DEL+'</button></div>'
      + '</div>'
      + flagRow(l)
      + snoozeRow(l)
      + editor
      + '</div>';
  }
  function renderLoops(){
    var el = document.getElementById("loops-list");
    if(!state.loops.length){ el.innerHTML = emptyState("No open follow-ups","When a Slack thread or email needs an action, log it here so it doesn't get buried."); return; }
    var open = state.loops.filter(function(l){return !l.done && !isSnoozed(l);});
    open.sort(function(a,b){
      var sa=staleLevel(a)?1:0, sb=staleLevel(b)?1:0;
      if(sa!==sb) return sb-sa;                 // stale loops rise to the top
      if(sa) return ageDays(b)-ageDays(a);      // oldest-owed first among them
      return 0;
    });
    var snoozed = state.loops.filter(function(l){return !l.done && isSnoozed(l);})
      .sort(function(a,b){ return new Date(a.snoozeUntil)-new Date(b.snoozeUntil); });  // soonest to return first
    var done = state.loops.filter(function(l){return l.done && visibleLocally(l);});
    var html = open.length ? open.map(loopCard).join('') : emptyState("No open follow-ups right now","Anything snoozed or closed is below.");
    if(snoozed.length){
      html += '<div class="group-label" style="margin-top:20px"><span class="eyebrow">Snoozed · '+snoozed.length+'</span><span class="line"></span></div>';
      html += snoozed.map(loopCard).join('');
    }
    if(done.length){
      html += collapsibleGroup("loops-closed","Closed",done.length, done.map(loopCard).join(''));
    }
    el.innerHTML = html;
  }

  function emptyState(h,p){ return '<div class="empty"><h3>'+h+'</h3><p>'+p+'</p></div>'; }
  function esc(s){ return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  var CHEV='<svg viewBox="0 0 24 24" class="chev-svg"><path d="M6 9l6 6 6-6"/></svg>';
  function isCollapsed(key){ return !!(state.settings.collapsed && state.settings.collapsed[key]); }
  // Flip based on what's on screen (the element's collapsed class), not the stored value —
  // a group shown collapsed via a defaultCol (e.g. "Past meetings") has no stored value yet,
  // so toggling the stored value would need two clicks to open. Reading the DOM avoids that.
  function toggleCollapse(g){ var key=g.getAttribute("data-collapse"); state.settings.collapsed=state.settings.collapsed||{}; state.settings.collapsed[key]=!g.classList.contains("collapsed"); persist(); renderAll(); }

  // Manual-add sections (task/loop) reuse the collapsed settings store but default
  // to COLLAPSED when unset — the opposite of isCollapsed — so they can't reuse it directly.
  var ADDERS=[["adder-task","t-title"],["adder-loop","l-src"]];
  function adderCollapsed(key){ var c=state.settings.collapsed; return (!c||c[key]===undefined)?true:!!c[key]; }
  function applyAdders(){
    ADDERS.forEach(function(a){
      var wrap=document.getElementById(a[0]+"-wrap"); if(!wrap) return;
      var col=adderCollapsed(a[0]);
      wrap.classList.toggle("collapsed",col);
      var t=wrap.querySelector(".adder-toggle"); if(t) t.setAttribute("aria-expanded",String(!col));
    });
  }
  function toggleAdder(key){
    state.settings.collapsed=state.settings.collapsed||{};
    var nowCollapsed=!adderCollapsed(key);
    state.settings.collapsed[key]=nowCollapsed;
    persist(); applyAdders();
    if(!nowCollapsed){ var f=document.getElementById(ADDERS.filter(function(a){return a[0]===key;}).map(function(a){return a[1];})[0]); if(f) f.focus(); }
  }
  function collapsibleGroup(key,label,count,cardsHtml,defaultCol){
    // Default to defaultCol only when the user hasn't toggled this group yet; once they have,
    // their stored choice wins. Existing callers pass no defaultCol → defaults to expanded.
    var c=state.settings.collapsed;
    var col=(c && key in c) ? !!c[key] : !!defaultCol;
    return '<div class="group-label collapsible'+(col?' collapsed':'')+'" data-collapse="'+key+'" role="button" tabindex="0" aria-expanded="'+(!col)+'" style="margin-top:20px">'
      + '<span class="chev">'+CHEV+'</span><span class="eyebrow">'+label+' · '+count+'</span><span class="line"></span></div>'
      + '<div class="group-body"'+(col?' hidden':'')+'>'+cardsHtml+'</div>';
  }

  // ---------- rendering: review queue ----------
  var REASONS = [["not-actionable","not actionable"],["wrong-type","wrong type"],["wrong-priority","wrong priority"],["already-handled","already handled"],["duplicate","duplicate"]];
  function reviewCard(item){
    var isTask = item.kind==="task";
    var title = isTask ? item.title : item.summary;
    var sub = isTask ? (item.note||"") : "";
    var who = isTask ? (item.area||"") : (item.who||"");
    var sys = (item.source&&item.source.system) ? item.source.system : (item.src||"");
    var glow = isTask ? taskGlow(item.pri) : loopGlow(item.needs);
    var metaBits = '';
    if(sys) metaBits += '<span class="r-src">'+esc(sys)+'</span>';
    if(who) metaBits += '<span class="r-src">'+esc(who)+'</span>';
    if(isTask){ metaBits += '<span class="tag eff" title="'+EFF_TITLE[item.eff||1]+'">'+EFF_LABEL[item.eff||1]+'</span>'; }
    else { metaBits += '<span class="needs '+item.needs+'" title="'+NEEDS_LABEL[item.needs]+'">needs '+item.needs+'</span>'; }
    if(item.link) metaBits += linkChip(item.link, !!item.altLink);
    if(item.altLink) metaBits += linkChip(item.altLink, false);
    var reasons = '<div class="reasons" data-reasons hidden><span class="rlabel">Reject — why? (helps tune the scan)</span>'
      + REASONS.map(function(r){ return '<button class="reason-chip" data-reason="'+r[0]+'">'+r[1]+'</button>'; }).join('')
      + '</div>';
    var indicator = isTask
      ? '<span class="tag pri-'+item.pri+'" title="'+PRI_LABEL[item.pri]+'">'+item.pri+'</span>'
      : '<span class="dot" style="background:'+glow.dot+';margin-top:5px" title="'+glow.title+'"></span>';
    return '<div class="r-card'+(glow.cls?' '+glow.cls:'')+'" data-id="'+esc(item.id)+'">'
      + '<div class="r-top">'+indicator+'<span class="r-kind">'+(isTask?'task':'follow-up')+'</span>'
      + '<div class="r-body"><div class="r-title">'+esc(title)+'</div>'
      + (sub?'<div class="r-note">'+esc(sub)+'</div>':'')
      + '<div class="r-meta">'+metaBits+'</div></div></div>'
      + '<div class="r-actions"><button class="btn-approve" data-approve>Approve</button>'
      + '<button class="btn-reject" data-reject-open>Reject</button></div>'
      + reasons
      + '</div>';
  }
  function renderReview(){
    var el=document.getElementById("review-list");
    if(!state.pending.length){ el.innerHTML=emptyState("Queue's clear","New items from the morning scan land here for you to approve or reject."); return; }
    el.innerHTML = state.pending.map(reviewCard).join('');
  }

  // ---------- rendering: rejected archive ----------
  function rejectedCard(item){
    var isTask = item.kind==="task";
    var title = isTask ? item.title : item.summary;
    var when = item.rejectedAt ? new Date(item.rejectedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "";
    return '<div class="r-card glow-blue" data-id="'+esc(item.id)+'">'
      + '<div class="r-top"><span class="dot" style="background:var(--signal);margin-top:5px"></span><span class="r-kind" style="background:var(--surface-2);color:var(--muted)">'+(isTask?'task':'follow-up')+'</span>'
      + '<div class="r-body"><div class="r-title">'+esc(title)+'</div>'
      + '<div class="r-meta">'
      + (item.reason?'<span class="rej-reason">'+esc(item.reason.replace(/-/g," "))+'</span>':'')
      + (when?'<span class="rej-when">rejected '+when+'</span>':'')
      + '</div>'
      + '<button class="btn-restore" data-restore>↩ Restore to review</button>'
      + '</div></div></div>';
  }
  function renderRejected(){
    var el=document.getElementById("rejected-list");
    if(!state.rejected.length){ el.innerHTML=emptyState("Nothing rejected","Items you reject show up here so you can reassess them later."); return; }
    el.innerHTML = state.rejected.slice().reverse().map(rejectedCard).join('');
  }

  // ---------- archive (resolved tasks + closed loops) ----------
  var RESOLUTION_META={
    completed:{label:"completed",color:"var(--load-1)",glow:"glow-green"},
    reassigned:{label:"reassigned",color:"var(--signal)",glow:"glow-blue"},
    dropped:{label:"dropped",color:"var(--faint)",glow:""}
  };
  function archiveCard(item){
    var isTask = state.tasks.indexOf(item)>-1;
    var title = isTask ? item.title : item.summary;
    var kind = isTask ? (item.resolution||"completed") : "completed";
    var meta = RESOLUTION_META[kind]||RESOLUTION_META.completed;
    var when = item.completedAt ? new Date(item.completedAt).toLocaleDateString(undefined,{month:"short",day:"numeric"}) : "";
    return '<div class="r-card'+(meta.glow?' '+meta.glow:'')+'" data-id="'+esc(item.id)+'">'
      + '<div class="r-top"><span class="dot" style="background:'+meta.color+';margin-top:5px"></span><span class="r-kind" style="background:var(--surface-2);color:'+meta.color+'">'+(isTask?'task':'follow-up')+'</span>'
      + '<div class="r-body"><div class="r-title">'+esc(title)+'</div>'
      + '<div class="r-meta">'
      + '<span class="rej-reason" style="color:'+meta.color+'">'+(isTask?meta.label:'closed')+'</span>'
      + (when?'<span class="rej-when">'+when+'</span>':'')
      + provenanceLine(item)
      + '</div>'
      + '<button class="btn-restore" data-archive-restore>\u21a9 Restore to active</button>'
      + '</div></div></div>';
  }
  function renderArchive(){
    var el=document.getElementById("archive-list");
    var items=state.tasks.concat(state.loops).filter(function(it){ return it.done; })
      .sort(function(a,b){ return new Date(b.completedAt||0)-new Date(a.completedAt||0); });
    if(!items.length){ el.innerHTML=emptyState("Nothing archived yet","Completed, reassigned, or dropped items collect here \u2014 permanently, restorable any time."); return; }
    el.innerHTML = items.map(archiveCard).join('');
  }

  // ---------- rendering: teams meetings ----------
  // A meeting folds into the collapsed "Past meetings" group if it's older than
  // MEETING_RECENT_DAYS OR the user manually filed it (m.filed). A missing/unparseable
  // date counts as recent so a dateless meeting can't silently hide in the collapsed group.
  var MEETING_RECENT_DAYS=14;
  function meetingAgeDays(m){ return m.date ? (Date.now()-new Date(m.date).getTime())/86400000 : 0; }
  function meetingIsEarlier(m){ return !!m.filed || meetingAgeDays(m) > MEETING_RECENT_DAYS; }
  function meetingCard(m){
    var when = m.date ? new Date(m.date).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"}) : "";
    // File button on recent cards; unfile only when un-filing would actually bring it back
    // (still within the window) — a genuinely-old meeting stays folded, so no misleading button.
    var earlier = meetingIsEarlier(m);
    var fileBtn = earlier
      ? (m.filed && meetingAgeDays(m) <= MEETING_RECENT_DAYS
          ? '<button class="icon-btn" data-unfile aria-label="Move to Recent" title="Move back to Recent">'+ICON_RECENT+'</button>' : '')
      : '<button class="icon-btn" data-file aria-label="Move to Past meetings" title="Move to Past meetings">'+ICON_PAST+'</button>';
    return '<div class="m-card glow-purple" data-id="'+esc(m.id)+'">'
      + '<div class="m-head"><div style="display:flex;gap:10px;align-items:flex-start"><span class="dot" style="background:var(--teams);margin-top:6px"></span><div><div class="m-title">'+esc(m.title||"Untitled meeting")+'</div>'
      + (when?'<div class="m-date">'+when+'</div>':'')+'</div></div>'
      + '<div class="m-actions">'
      + (m.link?'<a class="tag src-link" href="'+esc(m.link)+'" target="_blank" rel="noopener noreferrer">'+ICON_LINK+'recording</a>':'')
      + fileBtn
      + '<button class="icon-btn" data-del aria-label="Delete">'+ICON_DEL+'</button></div></div>'
      + (m.notes?'<div class="m-notes">'+esc(m.notes)+'</div>':'')
      + '</div>';
  }
  function renderMeetings(){
    var el=document.getElementById("meetings-list");
    if(!state.meetings.length){ el.innerHTML=emptyState("No meetings captured","Recorded Teams meetings with notes show up here after a scan."); return; }
    var items=state.meetings.slice().sort(function(a,b){ return String(b.date||"").localeCompare(String(a.date||"")); });
    var recent=items.filter(function(m){ return !meetingIsEarlier(m); });
    var earlier=items.filter(meetingIsEarlier);
    var html = recent.map(meetingCard).join('');
    if(earlier.length){
      // When nothing is recent (a quiet stretch), open the group by default so the tab
      // isn't just a lone collapsed bar; a manual toggle still persists and overrides this.
      html += collapsibleGroup("teams-past","Past meetings",earlier.length, earlier.map(meetingCard).join(''), recent.length>0);
    }
    el.innerHTML = html;
  }

  // ---------- weekly review ----------
  function startOfWeek(){ var m=new Date(weekDates().mon); m.setHours(0,0,0,0); return m; }
  function itemTitle(it){ return esc(it.title||it.summary||"(untitled)"); }
  function buildWeekly(){
    var body=document.getElementById("weekly-body");
    var wd=weekDates();
    var weekStart=startOfWeek().getTime();
    var range=wd.mon.toLocaleDateString(undefined,{month:"short",day:"numeric"})+" \u2013 "+wd.fri.toLocaleDateString(undefined,{month:"short",day:"numeric"});
    var all=state.tasks.concat(state.loops);

    var resolvedWk=all.filter(function(it){ return it.done && it.completedAt && new Date(it.completedAt).getTime()>=weekStart; });
    var closed=resolvedWk.filter(function(it){ return !it.resolution || it.resolution==="completed"; })
      .sort(function(a,b){ return new Date(b.completedAt)-new Date(a.completedAt); });
    var reassignedCt=resolvedWk.filter(function(it){ return it.resolution==="reassigned"; }).length;
    var droppedCt=resolvedWk.filter(function(it){ return it.resolution==="dropped"; }).length;
    var aging=all.filter(function(it){ return staleLevel(it); }).sort(function(a,b){ return ageDays(b)-ageDays(a); });
    var owed=state.loops.filter(function(l){ return !l.done && !isSnoozed(l); }).sort(function(a,b){ return ageDays(b)-ageDays(a); });

    function list(items, render, empty){
      if(!items.length) return '<div class="wk-empty">'+empty+'</div>';
      var out=items.slice(0,8).map(render).join('');
      if(items.length>8) out+='<div class="wk-more">+ '+(items.length-8)+' more</div>';
      return out;
    }
    function daysRow(offset){
      return '<div class="wk-days">'+DAYS.map(function(d){
        var dt=new Date(wd[d[0]]); dt.setDate(dt.getDate()+offset);
        var h=meetingHoursFor(isoDate(dt)), pct=Math.min(1,h/dailyCeiling());
        var col=STATUS_META[autoStatus(h/dailyCeiling())].color;
        return '<div class="wk-day"><div class="wk-day-name">'+d[1]+'</div>'
          +'<div class="wk-day-bar"><div class="wk-day-fill" style="height:'+(pct*100)+'%;background:'+col+'"></div></div>'
          +'<div class="wk-day-h">'+fmtH(h)+'h</div></div>';
      }).join('')+'</div>';
    }
    var nextHasData=DAYS.some(function(d){ var dt=new Date(wd[d[0]]); dt.setDate(dt.getDate()+7); return meetingHoursFor(isoDate(dt))>0; });

    var html='<div class="wk-range">Week of '+range+'</div>';
    html+='<div class="wk-section"><div class="wk-h">Closed this week <span class="wk-count">'+closed.length+'</span></div>'
      + ((reassignedCt||droppedCt) ? '<div class="wk-sub">'+(reassignedCt?reassignedCt+' reassigned':'')+((reassignedCt&&droppedCt)?' \u00b7 ':'')+(droppedCt?droppedCt+' dropped':'')+' \u2014 not wins, but off your plate.</div>' : '')
      + list(closed,function(it){ var when=new Date(it.completedAt).toLocaleDateString(undefined,{weekday:"short"}); return '<div class="wk-item"><span class="wk-check">\u2713</span><span class="wk-item-t">'+itemTitle(it)+'</span><span class="wk-item-meta">'+when+'</span></div>'; },"Nothing marked done yet \u2014 the week's young.")
      +'</div>';
    html+='<div class="wk-section"><div class="wk-h">Needs attention <span class="wk-count">'+aging.length+'</span></div>'
      + '<div class="wk-sub">Open 5+ days \u2014 clear or reset before it rots.</div>'
      + list(aging,function(it){ var lvl=staleLevel(it); return '<div class="wk-item"><span class="wk-age '+lvl+'">'+ageDays(it)+'d</span><span class="wk-item-t">'+itemTitle(it)+'</span></div>'; },"Nothing's slipping. Nice.")
      +'</div>';
    html+='<div class="wk-section"><div class="wk-h">Still owed <span class="wk-count">'+owed.length+'</span></div>'
      + '<div class="wk-sub">Open follow-ups \u2014 who\u2019s waiting on you.</div>'
      + list(owed,function(l){ return '<div class="wk-item"><span class="wk-who">'+esc(l.who||l.src)+'</span><span class="wk-item-t">'+esc(l.summary)+'</span><span class="wk-item-meta">'+ageDays(l)+'d</span></div>'; },"No open follow-ups. You\u2019re square with everyone.")
      +'</div>';
    html+='<div class="wk-section"><div class="wk-h">This week\u2019s meeting load</div>'+daysRow(0)+'</div>';
    html+='<div class="wk-section"><div class="wk-h">The week ahead</div>'
      + (nextHasData ? daysRow(7) : '<div class="wk-empty">Run a scan to pull next week\u2019s meeting hours.</div>')
      + '</div>';
    body.innerHTML=html;
  }

  function counts(){
    document.getElementById("c-today").textContent = state.tasks.filter(function(t){return isTodayBucket(t.bucket)&&!t.done;}).length || "";
    var wk = state.tasks.filter(function(t){return ["mon","tue","wed","thu","fri"].indexOf(t.bucket)>-1 && !t.done;}).length;
    document.getElementById("c-week").textContent = wk || "";
    document.getElementById("c-later").textContent = state.tasks.filter(function(t){return t.bucket==="later"&&!t.done;}).length || "";
    document.getElementById("c-loops").textContent = state.loops.filter(function(l){return !l.done && !isSnoozed(l);}).length || "";
    document.getElementById("c-teams").textContent = state.meetings.length || "";
    document.getElementById("c-review").textContent = state.pending.length || "";
    document.getElementById("c-archive").textContent = state.tasks.concat(state.loops).filter(function(it){return it.done;}).length || "";
    document.getElementById("c-rejected").textContent = state.rejected.length || "";
  }

  function updateTitle(){
    var n=state.pending&&state.pending.length;
    document.title=n?"("+n+") Otto":"Otto";
  }
  function updateSyncAge(){
    var el=document.getElementById("syncAge"); if(!el) return;
    var lr=state.meta&&state.meta.lastRun;
    if(!lr){ el.textContent=""; el.style.display="none"; return; }
    el.style.display="";
    var mins=Math.round((Date.now()-new Date(lr).getTime())/60000);
    if(mins<1) el.textContent="synced just now";
    else if(mins<60) el.textContent="synced "+mins+"m ago";
    else if(mins<1440) el.textContent="synced "+Math.round(mins/60)+"h ago";
    else el.textContent="synced "+new Date(lr).toLocaleDateString(undefined,{weekday:"short",month:"short",day:"numeric"});
  }
  function approveAll(){
    var n=state.pending&&state.pending.length; if(!n) return;
    var snap=snapshotForUndo();
    state.pending.slice().forEach(function(item){
      var kind=item.kind; delete item.kind;
      markProcessed(item);
      if(!item.created) item.created=new Date().toISOString();
      if(kind==="task") state.tasks.push(item); else state.loops.push(item);
    });
    state.pending=[];
    persist(); renderAll(); toastUndo("Approved "+n+(n===1?" item":" items"),function(){ restoreSnapshot(snap); });
  }
  function renderAll(){
    renderToday(); renderWeek(); renderLater(); renderLoops(); renderMeetings(); renderReview(); renderArchive(); renderRejected(); renderGauge(); renderStats(); renderName(); counts(); refreshBlurb(); showWelcome(); applyAdders(); updateTitle(); updateSyncAge();
    var aab=document.getElementById("approveAllBtn"); if(aab) aab.style.display=state.pending&&state.pending.length?"":"none";
  }
  function renderStats(){
    var el=document.getElementById("statline"); if(!el) return;
    var openTasks=state.tasks.filter(function(t){return !t.done;}).length;
    var openLoops=state.loops.filter(function(l){return !l.done && !isSnoozed(l);}).length;
    var weekStart=startOfWeek().getTime();
    var resolvedWk=state.tasks.concat(state.loops).filter(function(it){ return it.done && it.completedAt && new Date(it.completedAt).getTime()>=weekStart; });
    var doneWk=resolvedWk.filter(function(it){return !it.resolution||it.resolution==="completed";}).length;
    var reassignedWk=resolvedWk.filter(function(it){return it.resolution==="reassigned";}).length;
    var droppedWk=resolvedWk.filter(function(it){return it.resolution==="dropped";}).length;
    var agingCt=state.tasks.concat(state.loops).filter(function(it){ return staleLevel(it); }).length;
    var loops=state.loops.filter(function(l){return !l.done && !isSnoozed(l);});
    var avgAge=loops.length ? Math.round(loops.reduce(function(s,l){return s+ageDays(l);},0)/loops.length) : 0;
    var parts=[openTasks+" task"+(openTasks===1?"":"s"), openLoops+" follow-up"+(openLoops===1?"":"s")+" open"];
    var closedBit=doneWk+" done";
    if(reassignedWk) closedBit+=" · "+reassignedWk+" reassigned";
    if(droppedWk) closedBit+=" · "+droppedWk+" dropped";
    parts.push(closedBit+" this week");
    if(agingCt) parts.push(agingCt+" aging");
    if(loops.length) parts.push("avg follow-up age "+avgAge+"d");
    el.textContent = "On your plate: "+parts.join(" · ");
  }

  // ---------- events ----------
  function addTask(){
    var title = document.getElementById("t-title").value.trim();
    if(!title) return;
    state.tasks.push({
      id:uid(), title:title,
      type:document.getElementById("t-type").value,
      area:document.getElementById("t-area").value.trim(),
      eff:parseInt(document.getElementById("t-eff").value,10),
      pri:document.getElementById("t-pri").value,
      bucket:document.getElementById("t-bucket").value,
      link:normalizeUrl(document.getElementById("t-link").value),
      note:document.getElementById("t-note").value.trim(),
      done:false, created:new Date().toISOString()
    });
    document.getElementById("t-title").value="";
    document.getElementById("t-area").value="";
    document.getElementById("t-link").value="";
    document.getElementById("t-note").value="";
    persist(); renderAll();
    document.getElementById("t-title").focus();
  }
  function addLoop(){
    var summary=document.getElementById("l-summary").value.trim();
    if(!summary) return;
    state.loops.push({
      id:uid(),
      src:document.getElementById("l-src").value,
      who:document.getElementById("l-who").value.trim(),
      summary:summary,
      needs:document.getElementById("l-needs").value,
      link:normalizeUrl(document.getElementById("l-link").value),
      done:false, created:new Date().toISOString()
    });
    document.getElementById("l-summary").value="";
    document.getElementById("l-who").value="";
    document.getElementById("l-link").value="";
    persist(); renderAll();
    document.getElementById("l-who").focus();
  }

  document.getElementById("t-add").addEventListener("click",addTask);
  document.getElementById("t-title").addEventListener("keydown",function(e){ if(e.key==="Enter") addTask(); });
  document.getElementById("t-area").addEventListener("keydown",function(e){ if(e.key==="Enter") addTask(); });
  document.getElementById("t-note").addEventListener("keydown",function(e){ if(e.key==="Enter") addTask(); });
  document.getElementById("l-add").addEventListener("click",addLoop);
  document.getElementById("l-summary").addEventListener("keydown",function(e){ if(e.key==="Enter") addLoop(); });
  document.getElementById("l-link").addEventListener("keydown",function(e){ if(e.key==="Enter") addLoop(); });

  // delegated clicks on task + loop containers
  ["today-list","week-grid","later-list","loops-list"].forEach(function(cid){
    document.getElementById(cid).addEventListener("click",function(e){
      var card = e.target.closest("[data-id]"); if(!card) return;
      var id = card.getAttribute("data-id");
      if(e.target.closest("[data-check]")){ toggle(id); return; }
      if(e.target.closest("[data-del]")){ del(id); return; }
      if(e.target.closest("[data-edit]")){ openEditor(card); return; }
      if(e.target.closest("[data-flag]")){ toggleFlag(card,id); return; }
      if(e.target.closest("[data-snooze]")){ var sr=card.querySelector("[data-snoozerow]"); if(sr) sr.hidden=!sr.hidden; return; }
      var sopt=e.target.closest("[data-snooze-opt]"); if(sopt){ setSnooze(id, sopt.getAttribute("data-snooze-opt")); return; }
      if(e.target.closest("[data-wake]")){ wakeLoop(id); return; }
      if(e.target.closest("[data-agereset]")){ var it=findAny(id); if(it){ it.created=new Date().toISOString(); persist(); renderAll(); toast("Clock reset — still on it"); } return; }
      if(e.target.closest("[data-resolve]")){ var rr=card.querySelector("[data-resolverow]"); if(rr) rr.hidden=!rr.hidden; return; }
      var ropt=e.target.closest("[data-resolve-opt]"); if(ropt){ resolveItem(id, ropt.getAttribute("data-resolve-opt")); return; }
      var fsrc=e.target.closest("[data-flag-src]"); if(fsrc){ flagMissed(id, fsrc.getAttribute("data-flag-src")); return; }
      if(e.target.closest("[data-e-cancel]")){ renderAll(); return; }
      if(e.target.closest("[data-e-save]")){
        if(card.classList.contains("loop-card")) saveLoopEditor(card,id);
        else saveEditor(card,id);
        return;
      }
    });
    document.getElementById(cid).addEventListener("keydown",function(e){
      if(e.key!=="Enter"&&e.key!==" ") return;
      var chk=e.target.closest("[data-check]"); if(!chk) return;
      e.preventDefault();
      var card=e.target.closest("[data-id]"); if(card) toggle(card.getAttribute("data-id"));
    });
    document.getElementById(cid).addEventListener("change",function(e){
      var mtg=e.target.closest("[data-mtg]");
      if(mtg){ var v=parseFloat(mtg.value); if(isNaN(v)||v<0) v=0; state.meetingHours[mtg.getAttribute("data-mtg")]=v; persist(); refreshBudgetUI(); renderAll(); return; }
      var mv=e.target.closest("[data-move]"); if(!mv) return;
      var card=e.target.closest("[data-id]"); if(!card) return;
      var t=find(card.getAttribute("data-id")); if(t){ t.bucket=mv.value; persist(); renderAll(); }
    });
  });

  function normalizeUrl(u){
    u=(u||"").trim();
    if(!u) return "";
    if(!/^https?:\/\//i.test(u)) u="https://"+u;
    return u;
  }

  // ---------- review + rejected actions ----------
  document.getElementById("review-list").addEventListener("click",function(e){
    var card=e.target.closest("[data-id]"); if(!card) return;
    var id=card.getAttribute("data-id");
    if(e.target.closest("[data-approve]")){ approveItem(id); return; }
    if(e.target.closest("[data-reject-open]")){ var r=card.querySelector("[data-reasons]"); if(r) r.hidden=!r.hidden; return; }
    var chip=e.target.closest("[data-reason]");
    if(chip){ rejectItem(id, chip.getAttribute("data-reason")); return; }
  });
  document.getElementById("rejected-list").addEventListener("click",function(e){
    var card=e.target.closest("[data-id]"); if(!card) return;
    if(e.target.closest("[data-restore]")) restoreItem(card.getAttribute("data-id"));
  });
  document.getElementById("archive-list").addEventListener("click",function(e){
    var card=e.target.closest("[data-id]"); if(!card) return;
    if(e.target.closest("[data-archive-restore]")) restoreResolution(card.getAttribute("data-id"));
  });
  document.getElementById("meetings-list").addEventListener("click",function(e){
    var card=e.target.closest("[data-id]"); if(!card) return;
    if(e.target.closest("[data-del]")){ del(card.getAttribute("data-id")); return; }
    if(e.target.closest("[data-file]")){ setMeetingFiled(card.getAttribute("data-id"),true); return; }
    if(e.target.closest("[data-unfile]")){ setMeetingFiled(card.getAttribute("data-id"),false); return; }
  });
  document.getElementById("approveAllBtn").addEventListener("click", approveAll);
  document.getElementById("resetScanBtn").addEventListener("click",function(){
    if(!window.confirm("Reset scan history?\n\nThis empties the Review queue and Rejected archive, and clears what the scan remembers — so the next scan re-imports everything as new.\n\nYour approved tasks, follow-ups, and Teams meetings are kept.")) return;
    state.pending=[]; state.rejected=[];
    state.meta.processedSourceIds=[]; state.meta.feedback=[];
    persist(); renderAll(); toast("Scan history reset");
  });

  function takePending(id){
    var i = state.pending.findIndex(function(x){return x.id===id;});
    if(i<0) return null;
    return state.pending.splice(i,1)[0];
  }
  function sourceIdOf(item){ return (item.source&&item.source.sourceId) || item.id; }
  function markProcessed(item){
    var sid = sourceIdOf(item);
    if(state.meta.processedSourceIds.indexOf(sid)<0) state.meta.processedSourceIds.push(sid);
  }
  function snapshotForUndo(){
    return {
      pending: JSON.parse(JSON.stringify(state.pending)),
      tasks: JSON.parse(JSON.stringify(state.tasks)),
      loops: JSON.parse(JSON.stringify(state.loops)),
      rejected: JSON.parse(JSON.stringify(state.rejected)),
      processedSourceIds: state.meta.processedSourceIds.slice(),
      feedback: JSON.parse(JSON.stringify(state.meta.feedback))
    };
  }
  function restoreSnapshot(s){
    state.pending=s.pending; state.tasks=s.tasks; state.loops=s.loops; state.rejected=s.rejected;
    state.meta.processedSourceIds=s.processedSourceIds; state.meta.feedback=s.feedback;
    persist(); renderAll(); toast("Undone");
  }
  function approveItem(id){
    var snap=snapshotForUndo();
    var item=takePending(id); if(!item) return;
    var kind=item.kind; delete item.kind;
    markProcessed(item);
    if(!item.created) item.created=new Date().toISOString();   // clock starts when it hits the board
    if(kind==="task") state.tasks.push(item); else state.loops.push(item);
    persist(); renderAll(); toastUndo("Approved", function(){ restoreSnapshot(snap); });
  }
  function rejectItem(id, reason){
    var snap=snapshotForUndo();
    var item=takePending(id); if(!item) return;
    markProcessed(item);
    bumpFeedback(item, reason);
    item.reason=reason; item.rejectedAt=new Date().toISOString();
    state.rejected.push(item);
    persist(); renderAll(); toastUndo("Rejected — filed in the archive", function(){ restoreSnapshot(snap); });
  }
  function restoreItem(id){
    var i=state.rejected.findIndex(function(x){return x.id===id;});
    if(i<0) return;
    var item=state.rejected.splice(i,1)[0];
    delete item.reason; delete item.rejectedAt;
    state.pending.push(item);
    persist(); renderAll(); toast("Restored to review");
  }
  function bumpFeedback(item, reason){
    var system=(item.source&&item.source.system)||item.src||"";
    var signal=(item.kind==="task"?(item.area||""):(item.who||""));
    var fb=state.meta.feedback, hit=null;
    for(var i=0;i<fb.length;i++){ if(fb[i].match&&fb[i].match.system===system&&fb[i].match.signal===signal){ hit=fb[i]; break; } }
    if(hit){ hit.count++; hit.reason=reason; }
    else fb.push({match:{system:system,signal:signal},reason:reason,count:1});
  }

  document.getElementById("reviewModeChk").addEventListener("change",function(){
    state.settings.reviewMode=this.checked; persist();
  });

  function openEditor(card){
    var ed=card.querySelector("[data-editor]"); if(!ed) return;
    ed.hidden=false;
    var f=ed.querySelector("input,textarea,select"); if(f) f.focus();
  }
  function saveEditor(card,id){
    var t=find(id); if(!t) return;
    var ed=card.querySelector("[data-editor]"); if(!ed) return;
    var title=ed.querySelector("[data-e-title]").value.trim();
    if(title) t.title=title;
    t.note=ed.querySelector("[data-e-note]").value.trim();
    t.link=normalizeUrl(ed.querySelector("[data-e-link]").value);
    var alt=ed.querySelector("[data-e-altlink]"); if(alt) t.altLink=normalizeUrl(alt.value);
    persist(); renderAll();
  }
  function findLoop(id){ return state.loops.filter(function(l){return l.id===id;})[0]; }
  function saveLoopEditor(card,id){
    var l=findLoop(id); if(!l) return;
    var ed=card.querySelector("[data-editor]"); if(!ed) return;
    l.src=ed.querySelector("[data-e-src]").value;
    l.who=ed.querySelector("[data-e-who]").value.trim();
    var sum=ed.querySelector("[data-e-summary]").value.trim();
    if(sum) l.summary=sum;
    l.needs=ed.querySelector("[data-e-needs]").value;
    l.link=normalizeUrl(ed.querySelector("[data-e-link]").value);
    persist(); renderAll();
  }
  function find(id){ return state.tasks.filter(function(t){return t.id===id;})[0]; }
  function findAny(id){ return find(id) || findLoop(id); }
  function toggleFlag(card,id){
    var item=findAny(id); if(!item) return;
    if(item.missed){ unflagMissed(id); return; }           // already flagged → clear it
    var row=card.querySelector("[data-flagrow]"); if(row) row.hidden=!row.hidden;  // else reveal source picker
  }
  function flagMissed(id, source){
    var item=findAny(id); if(!item) return;
    var kind = state.loops.indexOf(item)>-1 ? "loop" : "task";
    item.missed={source:source, at:new Date().toISOString()};
    state.meta.missed=state.meta.missed||[];
    state.meta.missed.push({id:id, kind:kind, title:(item.title||item.summary||""), source:source, at:item.missed.at});
    persist(); renderAll(); toast("Flagged as a scan miss — noted for tuning");
  }
  function unflagMissed(id){
    var item=findAny(id); if(item) delete item.missed;
    state.meta.missed=(state.meta.missed||[]).filter(function(m){return m.id!==id;});
    persist(); renderAll();
  }
  function setSnooze(id, preset){
    var l=findLoop(id); if(!l) return;
    l.snoozeUntil=snoozeDate(preset);
    persist(); renderAll(); toast("Snoozed \u2014 returns "+shortWhen(l.snoozeUntil));
  }
  function wakeLoop(id){
    var l=findLoop(id); if(!l) return;
    delete l.snoozeUntil;
    persist(); renderAll(); toast("Back in your open follow-ups");
  }
  function toggle(id){
    var it=findAny(id); if(!it) return;
    it.done=!it.done;
    if(it.done){ it.completedAt=new Date().toISOString(); it.resolution="completed"; }
    else { delete it.completedAt; delete it.resolution; }
    persist(); renderAll();
  }
  function isJiraLink(url){ if(!url) return false; try{ var u=new URL(url); return /atlassian|jira/.test(u.hostname) || /\/browse\//.test(u.pathname); }catch(e){ return false; } }
  function isJiraTask(t){ return !!(t && (t.link&&isJiraLink(t.link) || t.altLink&&isJiraLink(t.altLink))); }
  function resolveItem(id, type){
    var it=findAny(id); if(!it) return;
    it.done=true; it.resolution=type; it.completedAt=new Date().toISOString();
    persist(); renderAll();
    toast(type==="reassigned" ? "Marked reassigned" : "Marked dropped");
  }
  function restoreResolution(id){
    var it=findAny(id); if(!it) return;
    it.done=false; delete it.resolution; delete it.completedAt;
    persist(); renderAll(); toast("Restored to active");
  }
  // local visibility window: completed items tuck away after ~14 days; reassigned/dropped stay put (boomerang risk) — Archive always has everything
  var RESOLVE_WINDOW_DAYS=14;
  function visibleLocally(it){
    if(!it.done) return true;
    if(it.resolution && it.resolution!=="completed") return true;
    if(!it.completedAt) return true;
    return (Date.now()-new Date(it.completedAt).getTime())/86400000 <= RESOLVE_WINDOW_DAYS;
  }
  function resolutionTag(t){
    if(!t.resolution || t.resolution==="completed") return '';
    var label = t.resolution==="reassigned" ? "reassigned" : "dropped";
    return '<span class="resolution-tag '+t.resolution+'">'+label+'</span>';
  }
  // priority/needs → glow class + dot color + a hover tooltip explaining what the color means.
  // Shared by taskCard/loopCard AND reviewCard (pending items), so Review inherits the exact
  // same urgency language as the active board.
  var PRI_LABEL = {high:"High priority", med:"Medium priority", low:"Low priority"};
  var NEEDS_LABEL = {reply:"Needs a reply", review:"Needs a review", other:"Needs follow-up"};
  var EFF_TITLE = {1:"Effort: Small (~1h)", 2:"Effort: Medium (~2h)", 3:"Effort: Large (~4h)"};
  function taskGlow(pri){
    if(pri==="high") return {cls:"glow-red", dot:"var(--brand)", title:PRI_LABEL.high};
    if(pri==="med")  return {cls:"glow-amber", dot:"var(--load-2)", title:PRI_LABEL.med};
    return {cls:"", dot:"var(--faint)", title:PRI_LABEL.low};
  }
  function loopGlow(needs){
    if(needs==="reply")  return {cls:"glow-blue", dot:"var(--signal)", title:NEEDS_LABEL.reply};
    if(needs==="review") return {cls:"glow-amber", dot:"var(--load-2)", title:NEEDS_LABEL.review};
    return {cls:"", dot:"var(--faint)", title:NEEDS_LABEL.other};
  }
  function resolveMenuButton(t){
    if(!isJiraTask(t) || t.done) return '';
    return '<button class="icon-btn resolve" data-resolve aria-label="Mark reassigned or dropped" title="This ticket moved on without me completing it">'+ICON_RESOLVE+'</button>';
  }
  function resolveRow(t){
    if(!isJiraTask(t) || t.done) return '';
    return '<div class="flag-src resolve-src" data-resolverow hidden><span class="rlabel">Mark as\u2026</span>'
      + '<button class="reason-chip" data-resolve-opt="reassigned">Reassigned</button>'
      + '<button class="reason-chip" data-resolve-opt="dropped">Dropped</button>'
      + '</div>';
  }
  function del(id){
    state.tasks=state.tasks.filter(function(t){return t.id!==id;});
    state.loops=state.loops.filter(function(l){return l.id!==id;});
    state.meetings=state.meetings.filter(function(m){return m.id!==id;});
    persist(); renderAll();
  }
  function setMeetingFiled(id,filed){
    var m=state.meetings.filter(function(x){return x.id===id;})[0]; if(!m) return;
    m.filed=filed; persist(); renderAll();
    toast(filed?"Moved to Past meetings":"Moved to Recent");
  }

  // nav
  function switchView(name){
    document.querySelectorAll('nav.views button').forEach(function(b){ b.setAttribute("aria-selected", b.dataset.view===name?"true":"false"); });
    document.querySelectorAll('.view').forEach(function(v){ v.classList.remove("active"); });
    document.getElementById("view-"+name).classList.add("active");
  }
  document.querySelectorAll('nav.views button').forEach(function(btn){
    btn.addEventListener("click",function(){ switchView(btn.dataset.view); });
  });

  // capacity panel
  var panel=document.getElementById("panel"), scrim=document.getElementById("scrim");
  var weeklyPanel=document.getElementById("weeklyPanel");
  var aboutPanel=document.getElementById("aboutPanel");
  function openPanel(){ panel.classList.add("open"); scrim.classList.add("open"); panel.setAttribute("aria-hidden","false"); refreshBlurb(); }
  function closePanels(){
    panel.classList.remove("open"); panel.setAttribute("aria-hidden","true");
    weeklyPanel.classList.remove("open"); weeklyPanel.setAttribute("aria-hidden","true");
    aboutPanel.classList.remove("open"); aboutPanel.setAttribute("aria-hidden","true");
    scrim.classList.remove("open");
  }
  var closePanel=closePanels;
  function openWeekly(){ buildWeekly(); weeklyPanel.classList.add("open"); scrim.classList.add("open"); weeklyPanel.setAttribute("aria-hidden","false"); }
  function openAbout(){ aboutPanel.classList.add("open"); scrim.classList.add("open"); aboutPanel.setAttribute("aria-hidden","false"); }
  document.getElementById("gaugeBtn").addEventListener("click",openPanel);
  document.getElementById("panelClose").addEventListener("click",closePanels);
  document.getElementById("weeklyBtn").addEventListener("click",openWeekly);
  document.getElementById("weeklyClose").addEventListener("click",closePanels);
  document.getElementById("aboutBtn").addEventListener("click",openAbout);
  document.getElementById("aboutClose").addEventListener("click",closePanels);
  document.getElementById("weeklyBtn").innerHTML='<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM3 9h18M8 3v3M16 3v3M8 15l2.5 2.5L16 12"/></svg>';
  document.getElementById("aboutBtn").innerHTML='<svg viewBox="0 0 24 24" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.5h.01"/></svg>';

  document.addEventListener("click",function(e){
    var g=e.target.closest("[data-collapse]"); if(!g) return;
    toggleCollapse(g);
  });
  document.addEventListener("keydown",function(e){
    if(e.key!=="Enter"&&e.key!==" ") return;
    var g=e.target.closest("[data-collapse]"); if(!g) return;
    e.preventDefault(); toggleCollapse(g);
  });
  document.addEventListener("click",function(e){
    var a=e.target.closest("[data-adder]"); if(!a) return;
    toggleAdder(a.getAttribute("data-adder"));
  });
  document.addEventListener("keydown",function(e){
    if(e.key!=="Enter"&&e.key!==" ") return;
    var a=e.target.closest("[data-adder]"); if(!a) return;
    e.preventDefault(); toggleAdder(a.getAttribute("data-adder"));
  });

  // ---------- drag-to-schedule (week columns) ----------
  var dragId=null;
  document.addEventListener("dragstart",function(e){
    var card=e.target.closest(".card[draggable]"); if(!card){ return; }
    dragId=card.getAttribute("data-id");
    card.classList.add("dragging");
    if(e.dataTransfer){ e.dataTransfer.effectAllowed="move"; try{ e.dataTransfer.setData("text/plain",dragId); }catch(_){} }
  });
  document.addEventListener("dragend",function(e){
    var card=e.target.closest(".card"); if(card) card.classList.remove("dragging");
    document.querySelectorAll(".day-col.drop-hover").forEach(function(c){ c.classList.remove("drop-hover"); });
    dragId=null;
  });
  var grid=document.getElementById("week-grid");
  grid.addEventListener("dragover",function(e){
    var col=e.target.closest(".day-col"); if(!col||!dragId) return;
    e.preventDefault(); if(e.dataTransfer) e.dataTransfer.dropEffect="move";
    if(!col.classList.contains("drop-hover")){ grid.querySelectorAll(".drop-hover").forEach(function(c){c.classList.remove("drop-hover");}); col.classList.add("drop-hover"); }
  });
  grid.addEventListener("dragleave",function(e){
    var col=e.target.closest(".day-col"); if(col && !col.contains(e.relatedTarget)) col.classList.remove("drop-hover");
  });
  grid.addEventListener("drop",function(e){
    var col=e.target.closest(".day-col"); if(!col||!dragId) return;
    e.preventDefault();
    var day=col.getAttribute("data-day"); var t=find(dragId);
    if(t && t.bucket!==day){ t.bucket=day; persist(); renderAll(); toast("Moved to "+day.charAt(0).toUpperCase()+day.slice(1)); }
    else { renderAll(); }
    dragId=null;
  });
  scrim.addEventListener("click",closePanels);
  document.addEventListener("keydown",function(e){ if(e.key==="Escape") closePanels(); });

  document.getElementById("dailyHours").addEventListener("input",function(){
    var v=parseFloat(this.value); if(!isNaN(v)&&v>0){ state.settings.dailyHours=v; persist(); renderGauge(); renderWeek(); refreshBlurb(); }
  });
  document.getElementById("mtgToday").addEventListener("input",function(){
    var v=parseFloat(this.value); if(isNaN(v)||v<0) v=0;
    state.meetingHours[isoDate()]=v; persist(); renderGauge(); renderWeek(); refreshBlurb();
  });
  document.getElementById("statusSeg").addEventListener("click",function(e){
    var b=e.target.closest("button[data-s]"); if(!b) return;
    state.settings.manualStatus=b.dataset.s;
    document.querySelectorAll("#statusSeg button").forEach(function(x){ x.setAttribute("aria-pressed", x===b?"true":"false"); });
    persist(); renderGauge(); refreshBlurb();
  });
  document.getElementById("copyBlurb").addEventListener("click",function(){
    var txt=document.getElementById("blurb").value;
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(function(){ toast("Copied — paste it wherever"); },function(){ toast("Select and copy manually"); });
    } else { document.getElementById("blurb").select(); toast("Select and copy manually"); }
  });

  var toastTimer;
  function toast(msg){
    var t=document.getElementById("toast"); t.innerHTML=""; t.textContent=msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.classList.remove("show"); },1900);
  }
  function toastUndo(msg, onUndo){
    var t=document.getElementById("toast");
    t.innerHTML='<span></span><button class="toast-undo" type="button">Undo</button>';
    t.querySelector("span").textContent=msg;
    t.querySelector(".toast-undo").addEventListener("click",function(){ onUndo(); t.classList.remove("show"); });
    t.classList.add("show");
    clearTimeout(toastTimer); toastTimer=setTimeout(function(){ t.classList.remove("show"); },6000);
  }

  // theme
  var THEME_ICONS = {
    light:'<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark:'<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };
  function systemDark(){ return !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches); }
  function effectiveTheme(){
    var p = state.settings.theme;
    if(p==="light"||p==="dark") return p;
    return systemDark() ? "dark" : "light";   // p === "auto"
  }
  function applyTheme(pref){
    document.documentElement.setAttribute("data-theme", pref);   // 'auto' keeps CSS system-match
    var eff = effectiveTheme();
    var btn = document.getElementById("themeBtn");
    btn.innerHTML = THEME_ICONS[eff];
    var lbl = eff==="dark" ? "Switch to light theme" : "Switch to dark theme";
    btn.setAttribute("aria-label", lbl);
    btn.setAttribute("title", lbl);
  }
  document.getElementById("themeBtn").addEventListener("click",function(){
    var next = effectiveTheme()==="dark" ? "light" : "dark";
    state.settings.theme = next;
    applyTheme(next);
    persist();
  });
  // keep following the system while still on the default
  if(window.matchMedia){
    var mq = window.matchMedia("(prefers-color-scheme: dark)");
    var onSys = function(){ if(state.settings.theme==="auto") applyTheme("auto"); };
    if(mq.addEventListener) mq.addEventListener("change",onSys);
    else if(mq.addListener) mq.addListener(onSys);
  }

  // ---------- file link (otto-data.json) ----------
  var needsReconnect=false;
  // Sync arrows for the data-file button; the .sync-spin group is what the hover animation rotates.
  var ICON_SYNC='<svg viewBox="0 0 24 24"><g class="sync-spin"><polyline points="21 4 21 9 16 9"/><polyline points="3 20 3 15 8 15"/><path d="M4.2 9a8 8 0 0 1 13.2-3L21 9M3 15l3.6 3A8 8 0 0 0 19.8 15"/></g></svg>';
  // Orbiting-spark overlay for the data-file button; CSS reveals it on hover.
  var SYNC_FX='<span class="sync-fx" aria-hidden="true"><span class="sync-orbit"><i class="sync-tail"></i><i class="sync-dot"></i></span></span>';
  function showReconnect(on){ var bar=document.getElementById("reconnectBar"); if(bar) bar.hidden=!on; }
  var welcomeDismissed=false;   // session-only; reappears on reload if still genuinely empty
  function isFirstRunEmpty(){
    return !fileHandle && !welcomeDismissed
      && state.tasks.length===0 && state.loops.length===0
      && state.pending.length===0 && state.meetings.length===0;
  }
  function showWelcome(){ var bar=document.getElementById("welcomeBar"); if(bar) bar.hidden=!isFirstRunEmpty(); }
  function updateFileBtn(){
    var b=document.getElementById("fileBtn"); b.innerHTML=ICON_SYNC+SYNC_FX;
    b.classList.remove("linked","reconnect");
    if(needsReconnect){ b.classList.add("reconnect"); b.title="Data file needs reconnecting — click to reconnect"; b.setAttribute("aria-label","Reconnect data file"); }
    else if(fileHandle){ b.classList.add("linked"); b.title="Linked to otto-data.json — click to pull the latest"; b.setAttribute("aria-label","Refresh from linked file"); }
    else { b.title=fsSupported?"Link otto-data.json":"File linking needs Chrome or Edge"; b.setAttribute("aria-label","Link data file"); }
    showReconnect(needsReconnect);
    updateSyncAge();
  }
  function hydrate(parsed){
    if(!parsed) return;
    state.tasks=parsed.tasks||[];
    state.loops=parsed.loops||[];
    state.pending=parsed.pending||[];
    state.rejected=parsed.rejected||[];
    state.meetings=parsed.meetings||[];
    state.meetingHours=parsed.meetingHours||{};
    state.settings=Object.assign({budget:15,dailyHours:8,manualStatus:"auto",theme:"auto",reviewMode:true,collapsed:{},userName:""},parsed.settings||{});
    state.meta=Object.assign({lastRun:null,processedSourceIds:[],feedback:[],missed:[]},parsed.meta||{});
  }
  function applyReviewMode(){ document.getElementById("reviewModeChk").checked = state.settings.reviewMode!==false; }
  async function linkFile(){
    if(!fsSupported){ toast("File linking needs Chrome or Edge"); return; }
    try{
      var picks=await window.showOpenFilePicker({types:[{description:"Otto data",accept:{"application/json":[".json"]}}],multiple:false});
      var h=picks[0];
      if(!(await ensurePermission(h,true))){ toast("Permission denied"); return; }
      var data=await fileReadState(h);
      if(data && (data.tasks||data.loops||data.pending)){ hydrate(data); }   // file already has content → adopt it
      else { await fileWriteState(h); }                                       // empty file → migrate current data in
      fileHandle=h;
      needsReconnect=false;
      try{ await idbSetHandle(h); }catch(e){}
      updateFileBtn(); applyReviewMode(); refreshBudgetUI(); renderAll();
      if(state.pending && state.pending.length) switchView("review");
      toast("Linked to otto-data.json");
    }catch(e){ if(e && e.name!=="AbortError") toast("Couldn't link the file"); }
  }
  async function refreshFromFile(){
    if(!fileHandle) return;
    try{
      if(!(await ensurePermission(fileHandle,true))){ toast("Permission needed"); return; }
      var data=await fileReadState(fileHandle);
      needsReconnect=false;
      if(data){ hydrate(data); }
      applyReviewMode(); refreshBudgetUI(); updateFileBtn(); renderAll();
      if(state.pending && state.pending.length) switchView("review");
      toast(data ? "Pulled the latest from the file" : "Reconnected");
    }catch(e){ toast("Couldn't read the file"); }
  }
  function refreshBudgetUI(){
    document.getElementById("dailyHours").value = state.settings.dailyHours;
    document.getElementById("mtgToday").value = meetingHoursFor(isoDate());
    document.querySelectorAll("#statusSeg button").forEach(function(x){ x.setAttribute("aria-pressed", x.dataset.s===state.settings.manualStatus?"true":"false"); });
  }

  // ---------- header name ----------
  function renderName(){
    var el=document.getElementById("gaugeName"); if(!el||el.querySelector("input")) return;
    var name=(state.settings.userName||"").trim();
    if(!name){ el.textContent="+ add name"; el.classList.add("empty"); return; }
    el.classList.remove("empty");
    var parts=name.split(/\s+/);
    if(parts.length>1) el.innerHTML='<span>'+esc(parts[0])+'</span><span>'+esc(parts.slice(1).join(" "))+'</span>';
    else el.innerHTML='<span>'+esc(name)+'</span>';
  }
  function editName(){
    var el=document.getElementById("gaugeName");
    var current=state.settings.userName||"";
    el.innerHTML='';
    var input=document.createElement("input");
    input.className="gauge-name-input"; input.value=current; input.placeholder="Your name";
    input.maxLength=40;
    el.appendChild(input); input.focus(); input.select();
    function commit(){ state.settings.userName=input.value.trim(); persist(); renderName(); }
    input.addEventListener("keydown",function(e){
      if(e.key==="Enter"){ commit(); }
      else if(e.key==="Escape"){ renderName(); }
      e.stopPropagation();
    });
    input.addEventListener("blur",commit);
    input.addEventListener("click",function(e){ e.stopPropagation(); });
  }
  document.getElementById("gaugeName").addEventListener("click",function(e){ if(!e.target.closest("input")) editName(); });
  document.getElementById("gaugeName").addEventListener("keydown",function(e){
    if((e.key==="Enter"||e.key===" ") && !e.target.closest("input")){ e.preventDefault(); editName(); }
  });

  document.getElementById("fileBtn").addEventListener("click",function(){ if(fileHandle) refreshFromFile(); else linkFile(); });
  document.getElementById("reconnectBtn").addEventListener("click",function(){ if(fileHandle) refreshFromFile(); else linkFile(); });
  document.getElementById("welcomeLinkBtn").addEventListener("click",linkFile);
  document.getElementById("welcomeDismissBtn").addEventListener("click",function(){ welcomeDismissed=true; showWelcome(); });

  // date
  function setTodayDate(){
    var opts={weekday:"short",month:"short",day:"numeric"};
    document.getElementById("todayDate").textContent = new Date().toLocaleDateString(undefined,opts);
  }
  setTodayDate();
  var lastDay = new Date().toDateString();
  document.addEventListener("visibilitychange",function(){
    if(document.hidden) return;
    setTodayDate();
    var now = new Date().toDateString();
    if(now!==lastDay){ lastDay=now; renderAll(); }  // day rolled over → refresh week highlight
  });

  document.getElementById("footnote").textContent =
    "Data lives in this browser by default. Link otto-data.json (top-right) to share it with the Cowork scan — that's what feeds the Review queue and your meeting hours. Task sizes count as S=1h / M=2h / L=4h against your day.";

  // ---------- boot ----------
  (async function boot(){
    // 1) try a previously-linked file
    if(fsSupported){
      try{
        var h=await idbGetHandle();
        if(h){
          fileHandle=h;                                  // keep the reference across reloads
          if(await ensurePermission(h,false)){
            var data=await fileReadState(h);
            if(data) hydrate(data);
          } else {
            needsReconnect=true;                         // have the file, lost permission on reload
          }
        }
      }catch(e){ fileHandle=null; }
    }
    // 2) no linked file at all → browser storage (or first-run seed)
    if(!fileHandle){
      var raw = await store.get(KEY);
      if(raw){ try{ hydrate(JSON.parse(raw)); }catch(e){ state=JSON.parse(JSON.stringify(seed)); } }
      else { state=JSON.parse(JSON.stringify(seed)); persist(); }
    }
    // (if fileHandle is set but needsReconnect, state stays empty — we do NOT show seed as if it were theirs)
    // staleness clock: backfill created for any item that predates the feature
    (function(){ var now=new Date().toISOString(),ch=false;
      state.tasks.concat(state.loops).forEach(function(it){ if(!it.created){ it.created=now; ch=true; } });
      if(ch) persist();
    })();
    if(!state.settings.theme) state.settings.theme="auto";
    applyTheme(state.settings.theme);
    updateFileBtn();
    applyReviewMode();
    refreshBudgetUI();
    renderAll();
  })();

})();
