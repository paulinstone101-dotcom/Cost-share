// Offline support: app files are served from cache and refreshed in the background.
const VERSION='cs-v1';
const SHELL=['./','index.html','app.js','styles.css','firebase-config.js','manifest.webmanifest','icons/icon-192.png','icons/icon-512.png','icons/apple-touch-icon.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(VERSION).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSION).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  const sameOrigin=u.origin===location.origin;
  const staticCdn=/^(www\.gstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)$/.test(u.hostname)&&!u.pathname.includes('/v1/');
  if(!sameOrigin&&!staticCdn)return; // Firestore, auth and rates go straight to the network
  e.respondWith(caches.open(VERSION).then(async c=>{
    const hit=await c.match(e.request,{ignoreSearch:sameOrigin});
    const net=fetch(e.request).then(r=>{if(r.ok||r.type==='opaque')c.put(e.request,r.clone());return r}).catch(()=>hit);
    return hit||net;
  }));
});
