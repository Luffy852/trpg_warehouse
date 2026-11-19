var l={dnd:"DND",coc:"COC",other:"\u5176\u4ED6\u89C4\u5219"},a={campaign:"\u6218\u5F79",module:"\u6A21\u7EC4",encounter:"\u906D\u9047"};var g="/api/modules";function n(e){return String(e??"").replace(/[&<>"']/g,s=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[s])}function p(e){return String(e).split("/").map(encodeURIComponent).join("/")}function m(e){return e.cover?/^https?:\/\//i.test(e.cover)?e.cover:e.baseUrl+p(e.cover):""}function d(e){let s=m(e),r=s?`style="background-image:url('${n(s)}')"`:"";return`<a class="card" href="/module.html?slug=${encodeURIComponent(e.slug)}">
    <div class="card__cover" ${r}></div>
    <div class="card__body">
      <h3 class="card__title">${n(e.title)}</h3>
      <p class="card__meta">${n(l[e.system]??e.system)} \xB7 ${n(a[e.kind]??e.kind)}</p>
      <p class="card__summary">${n(e.summary)}</p>
    </div>
  </a>`}function f(e){let s=document.getElementById("app");if(e.length===0){s.innerHTML='<p class="empty">\u76EE\u524D\u8FD8\u6CA1\u6709\u5DF2\u53D1\u5E03\u7684\u6A21\u7EC4\u3002</p>';return}let r=[],t=e.filter(o=>o.system==="dnd");if(t.length){let o='<section class="section"><h2>DND</h2>';for(let c of["campaign","module","encounter"]){let i=t.filter(u=>u.kind===c);i.length&&(o+=`<h3>${n(a[c])} \xB7 ${i.length}</h3><div class="grid">${i.map(d).join("")}</div>`)}o+="</section>",r.push(o)}for(let o of["coc","other"]){let c=e.filter(i=>i.system===o);c.length&&r.push(`<section class="section"><h2>${n(l[o])} \xB7 ${c.length}</h2><div class="grid">${c.map(d).join("")}</div></section>`)}s.innerHTML=r.join("")}function h(e,s){let r=document.getElementById("app"),t=e.find(u=>u.slug===s);if(!t){r.innerHTML='<div class="error-box">\u627E\u4E0D\u5230\u8BE5\u6761\u76EE\uFF0C\u6216\u5B83\u5C1A\u672A\u53D1\u5E03\uFF08draft \u4E0D\u51FA\u73B0\u5728\u6D4F\u89C8\u7AEF\uFF09\u3002</div>';return}document.title=`${t.title} \xB7 TRPG \u6A21\u7EC4\u5E93`;let o=`/mindmap.html?slug=${encodeURIComponent(t.slug)}`,c=t.baseUrl+p(t.consoleFile),i=m(t);r.innerHTML=`
    <div class="module-head">
      <h2>${n(t.title)}</h2>
      <p class="meta">${n(l[t.system]??t.system)} \xB7 ${n(a[t.kind]??t.kind)}</p>
      ${i?`<p class="meta"><img src="${n(i)}" alt="\u5C01\u9762" style="max-width:220px;border-radius:8px"></p>`:""}
      <p class="summary">${n(t.summary)}</p>
    </div>
    <div class="entries">
      <a class="entry" href="${n(o)}">
        <strong>\u601D\u7EF4\u5BFC\u56FE</strong><small>\u6D4F\u89C8\u5668\u5185\u76F4\u63A5\u9884\u89C8 .xmind\uFF0C\u65E0\u9700\u5B89\u88C5\u5BA2\u6237\u7AEF</small>
      </a>
      <a class="entry" href="${n(c)}" target="_blank" rel="noopener">
        <strong>\u4E3B\u63A7\u53F0</strong><small>\u539F\u6837\u6253\u5F00\u6210\u54C1 HTML\uFF0C\u5185\u90E8\u539F\u6587 / \u5730\u56FE\u94FE\u63A5\u6309\u9700\u52A0\u8F7D</small>
      </a>
    </div>
    <div class="notice">
      \u672C\u7AD9\u4E3A\u516C\u5F00\u53EA\u8BFB\u7D22\u5F15\uFF0C\u4E0D\u5217\u4E3E\u3001\u4E0D\u63A8\u9001\u8D44\u6E90\u5305\uFF1B\u539F\u6587\u4E0E\u5730\u56FE\u7B49\u6587\u4EF6\u4EC5\u7531\u4E3B\u63A7\u53F0\u5185\u94FE\u63A5\u53D6\u7528\u3002<br>
      \u4E2D\u6587\u8BD1\u6587\u4E3A<strong>\u975E\u5B98\u65B9\u7C89\u4E1D\u7FFB\u8BD1\uFF0C\u7981\u6B62\u5546\u7528</strong>\uFF0C\u539F\u8BD1\u8005\u58F0\u660E\u4E0E\u7B2C\u4E09\u65B9\u7269\u6599\u58F0\u660E\u5728\u539F\u6587\u4E2D\u5B8C\u6574\u4FDD\u7559\u3002
    </div>`}async function y(){let e=document.getElementById("app");try{let s=await fetch(g,{cache:"no-store"});if(!s.ok)throw new Error(`\u5217\u8868\u63A5\u53E3\u8FD4\u56DE ${s.status}`);let r=await s.json(),t=Array.isArray(r.modules)?r.modules:[];document.body.dataset.page==="module"?h(t,new URLSearchParams(location.search).get("slug")??""):f(t)}catch(s){e.innerHTML=`<div class="error-box">\u8F7D\u5165\u5931\u8D25\uFF1A${n(s.message)}\u3002\u8BF7\u7A0D\u540E\u5237\u65B0\u91CD\u8BD5\u3002</div>`}}y();
