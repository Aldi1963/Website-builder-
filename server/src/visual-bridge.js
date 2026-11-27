(function () {
  var picking = false;
  function label(el) {
    var t = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    return t || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
  }
  function selector(el) {
    if (el.id) return '#' + el.id;
    var parts = [];
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 6; n = n.parentElement, i++) {
      var s = n.tagName.toLowerCase();
      if (n.className && typeof n.className === 'string') {
        var c = n.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        if (c) s += '.' + c.replace(/([:.#\[\]])/g, '\\$1');
      }
      var p = n.parentElement;
      if (p) {
        var same = [].filter.call(p.children, function (x) { return x.tagName === n.tagName; }).length;
        if (same > 1) s += ':nth-child(' + ([].indexOf.call(p.children, n) + 1) + ')';
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  }
  function send(el) {
    var r = el.getBoundingClientRect();
    parent.postMessage({ source: 'vb-visual-bridge', type: 'vb:pick', payload: {
      tag: el.tagName.toLowerCase(), label: label(el), selector: selector(el),
      text: (el.textContent || '').trim().slice(0, 240),
      x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height)
    } }, '*');
  }
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== 'vb-editor') return;
    if (e.data.type === 'vb:start-pick') { picking = true; document.body.style.cursor = 'crosshair'; }
    else if (e.data.type === 'vb:stop-pick') { picking = false; document.body.style.cursor = ''; }
  });
  document.addEventListener('click', function (e) {
    if (!picking) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target.closest('a,button,input,textarea,select,h1,h2,h3,p,li,[data-testid]') || e.target;
    send(el); picking = false; document.body.style.cursor = '';
  }, true);
  document.addEventListener('mouseover', function (e) {
    if (picking) e.target.style.outline = '2px solid #7c5cff';
  }, true);
  document.addEventListener('mouseout', function (e) {
    if (picking) e.target.style.outline = '';
  }, true);
})();
