/*!
 * VoxLive Widget — https://voxlive-backend.onrender.com
 * Usage:
 *   <div id="mon-conteneur"></div>
 *   <script src="https://voxlive-backend.onrender.com/widget.js"></script>
 *   <script>VoxLive.render({ poll: "VXL-XXXXX", container: "#mon-conteneur" });</script>
 */
(function(){
  var ORIGIN = (function(){
    var cur = document.currentScript;
    if(cur && cur.src){
      try { return new URL(cur.src).origin; } catch(e){}
    }
    return 'https://voxlive-backend.onrender.com';
  })();

  function render(opts){
    opts = opts || {};
    if(!opts.poll){ console.error('[VoxLive widget] "poll" (code du sondage) est requis.'); return; }
    var el = typeof opts.container === 'string' ? document.querySelector(opts.container) : opts.container;
    if(!el){ console.error('[VoxLive widget] conteneur introuvable :', opts.container); return; }

    var iframe = document.createElement('iframe');
    iframe.src = ORIGIN + '/embed/' + encodeURIComponent(opts.poll);
    iframe.width = '100%';
    iframe.height = opts.height || 560;
    iframe.style.border = '0';
    iframe.style.borderRadius = '16px';
    iframe.style.maxWidth = opts.maxWidth || '480px';
    iframe.loading = 'lazy';
    iframe.title = 'Sondage VoxLive';
    el.innerHTML = '';
    el.appendChild(iframe);

    if(typeof opts.onEvent === 'function'){
      window.addEventListener('message', function(e){
        if(e.origin !== ORIGIN) return;
        if(e.data && String(e.data.type||'').indexOf('voxlive:') === 0) opts.onEvent(e.data);
      });
    }
    return iframe;
  }

  window.VoxLive = { render: render };
})();
