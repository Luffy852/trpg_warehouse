var a={dnd:"DND",coc:"COC",other:"\u5176\u4ED6\u89C4\u5219"},d={campaign:"\u6218\u5F79",module:"\u6A21\u7EC4",encounter:"\u906D\u9047"};var p=location.pathname.startsWith("/upload/"),f=p?"/api/upload/admin/modules":"/api/modules";function n(t){return String(t??"").replace(/[&<>"']/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[s])}function m(t){return String(t).split("/").map(encodeURIComponent).join("/")}function g(t){return t.cover?/^https?:\/\//i.test(t.cover)?t.cover:t.baseUrl+m(t.cover):""}function u(t){let s=g(t),o=s?`<img class="card__art" src="${n(s)}" alt="\u5C01\u9762" loading="lazy">`:`<span class="card__cover-ph">${n(a[t.system]??t.system)}</span>`;return`<a class="card" href="/module.html?slug=${encodeURIComponent(t.slug)}">
    <div class="card__cover">${o}</div>
    <div class="card__body"><h3 class="card__title">${n(t.title)}</h3></div>
  </a>`}function h(t){let s=document.getElementById("app");if(t.length===0){s.innerHTML='<p class="empty">\u76EE\u524D\u8FD8\u6CA1\u6709\u5DF2\u53D1\u5E03\u7684\u6A21\u7EC4\u3002</p>';return}let o=[],e=t.filter(r=>r.system==="dnd");if(e.length){let r='<section class="section"><h2>DND</h2>';for(let c of["campaign","module","encounter"]){let i=e.filter(l=>l.kind===c);i.length&&(r+=`<h3>${n(d[c])}</h3><div class="grid">${i.map(u).join("")}</div>`)}r+="</section>",o.push(r)}for(let r of["coc","other"]){let c=t.filter(i=>i.system===r);c.length&&o.push(`<section class="section"><h2>${n(a[r])}</h2><div class="grid">${c.map(u).join("")}</div></section>`)}s.innerHTML=o.join("")}function y(t,s){let o=document.getElementById("app"),e=t.find(l=>l.slug===s);if(!e){o.innerHTML=`<div class="error-box">${p?"\u627E\u4E0D\u5230\u8BE5\u6761\u76EE\u3002":"\u627E\u4E0D\u5230\u8BE5\u6761\u76EE\uFF0C\u6216\u5B83\u5C1A\u672A\u53D1\u5E03\uFF08draft \u4E0D\u51FA\u73B0\u5728\u6D4F\u89C8\u7AEF\uFF09\u3002"}</div>`;return}document.title=`${e.title} \xB7 TRPG \u6A21\u7EC4\u5E93`;let r=`/${p?"upload/":""}mindmap.html?slug=${encodeURIComponent(e.slug)}`,c=e.baseUrl+m(e.consoleFile),i=g(e);o.innerHTML=`
    <div class="module-head">
      <h2>${n(e.title)}</h2>
      <p class="meta">${n(a[e.system]??e.system)} \xB7 ${n(d[e.kind]??e.kind)}</p>
      ${i?`<p class="meta"><img src="${n(i)}" alt="\u5C01\u9762" style="max-width:220px;border-radius:8px"></p>`:""}
      <p class="summary">${n(e.summary)}</p>
    </div>
    <div class="entries">
      <a class="entry" href="${n(r)}" target="_blank" rel="noopener">
        <strong>\u601D\u7EF4\u5BFC\u56FE</strong><small>\u5728\u6D4F\u89C8\u5668\u91CC\u67E5\u770B</small>
      </a>
      <a class="entry" href="${n(c)}" target="_blank" rel="noopener">
        <strong>\u4E3B\u63A7\u53F0</strong><small>\u6253\u5F00\u6A21\u7EC4\u539F\u6587\u4E0E\u5730\u56FE</small>
      </a>
    </div>
    <div class="notice">
      \u672C\u7AD9\u4E3A\u516C\u5F00\u53EA\u8BFB\u7D22\u5F15\uFF0C\u4E0D\u5217\u4E3E\u3001\u4E0D\u63A8\u9001\u8D44\u6E90\u5305\uFF1B\u539F\u6587\u4E0E\u5730\u56FE\u7B49\u6587\u4EF6\u4EC5\u7531\u4E3B\u63A7\u53F0\u5185\u94FE\u63A5\u53D6\u7528\u3002<br>
      \u4E2D\u6587\u8BD1\u6587\u4E3A<strong>\u975E\u5B98\u65B9\u7C89\u4E1D\u7FFB\u8BD1\uFF0C\u7981\u6B62\u5546\u7528</strong>\uFF0C\u539F\u8BD1\u8005\u58F0\u660E\u4E0E\u7B2C\u4E09\u65B9\u7269\u6599\u58F0\u660E\u5728\u539F\u6587\u4E2D\u5B8C\u6574\u4FDD\u7559\u3002
    </div>`}async function v(){let t=document.getElementById("app");try{let s=await fetch(f,{cache:"no-store"});if(!s.ok)throw new Error(`\u5217\u8868\u63A5\u53E3\u8FD4\u56DE ${s.status}`);let o=await s.json(),e=Array.isArray(o.modules)?o.modules:[];document.body.dataset.page==="module"?y(e,new URLSearchParams(location.search).get("slug")??""):h(e)}catch(s){t.innerHTML=`<div class="error-box">\u8F7D\u5165\u5931\u8D25\uFF1A${n(s.message)}\u3002\u8BF7\u7A0D\u540E\u5237\u65B0\u91CD\u8BD5\u3002</div>`}}v();
