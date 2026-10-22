// Scripted stage for the landing hero: a request typed into the drawer changes
// the dashboard next to it. No model runs here; each recipe is a pre-written
// transformation of the same page state, honestly labelled on the page.
// Undo, the version timetable and the status line mimic the real drawer.
(function () {
  var root = document.querySelector('[data-live]');
  if (!root) return;
  var tiles = root.querySelector('[data-zone="tiles"]');
  var pipeline = root.querySelector('[data-zone="pipeline"]');
  var customers = root.querySelector('[data-zone="customers"]');
  var dash = root.querySelector('.dash');
  var ruler = root.querySelector('.ruler');
  var verBtn = root.querySelector('[data-history]');
  var feed = root.querySelector('.feed');
  var text = root.querySelector('.prompt-bar .text');
  var cursor = root.querySelector('.prompt-bar .cursor');
  var sendBtn = root.querySelector('.prompt-bar .send');
  var undoBtn = root.querySelector('[data-undo]');
  var resetBtn = root.querySelector('[data-reset]');
  var recipes = Array.prototype.slice.call(root.querySelectorAll('.recipe'));
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var PLACEHOLDER = 'Describe a change or paste a screenshot';

  var data = {
    customers: [
      { name: 'Globex Corporation', due: 'Oct 11', overdue: true, amount: 12000 },
      { name: 'Initech', due: 'Oct 29', overdue: false, amount: 4500 },
      { name: 'Umbrella Health', due: 'Oct 16', overdue: true, amount: 9500 },
      { name: 'Stark Logistics', due: 'Nov 16', overdue: false, amount: 7200 }
    ],
    deals: [
      { title: 'Annual licence', stage: 'won', amount: 48000 },
      { title: 'Onboarding package', stage: 'qualified', amount: 40000 },
      { title: 'Support upgrade', stage: 'proposal', amount: 9500 }
    ]
  };
  function money(n) { return '$' + n.toLocaleString('en-US'); }

  // Each recipe: the request as the user types it, the steps the agent reports,
  // the one-line result, which panel it touches and the state it adds.
  var recipesMap = {
    overdue: {
      label: 'Overdue tile', zone: 'tiles', set: { overdueTile: true },
      lines: ['Understanding the request', "Looking at the app's data helpers", 'Adding a tile to the dashboard', 'Checking that everything still works'],
      summary: 'A new tile shows the 2 overdue payments, $21,500 in total.'
    },
    bars: {
      label: 'Pipeline as bars', zone: 'pipeline', set: { bars: true },
      lines: ['Understanding the request', 'Changing the deals panel', 'Checking that everything still works'],
      summary: 'The deals table is now a bar chart by stage. The numbers are the same.'
    },
    sort: {
      label: 'Overdue first', zone: 'customers', set: { sortOverdue: true },
      lines: ['Understanding the request', 'Changing the customer list', 'Checking that everything still works'],
      summary: 'Overdue customers come first and their dates are marked in red.'
    },
    compact: {
      label: 'Compact layout', zone: 'all', set: { compact: true },
      lines: ['Understanding the request', 'Tightening spacing on three panels', 'Checking that everything still works'],
      summary: 'The dashboard is more compact; nothing was removed.'
    },
    backend: {
      label: 'Discount on the server', backend: true,
      lines: ['Understanding the request', 'This needs a change on the server'],
      summary: 'Totals are computed on the server, so this is not a page change. Sent to your admin; nothing was changed.'
    }
  };

  function tilesHtml(s) {
    var open = data.deals.filter(function (d) { return d.stage !== 'won'; });
    var openSum = open.reduce(function (a, d) { return a + d.amount; }, 0);
    var od = data.customers.filter(function (c) { return c.overdue; });
    var odSum = od.reduce(function (a, c) { return a + c.amount; }, 0);
    var h = '<div class="tile"><span class="k">Customers</span><b>4</b><small>2 active</small></div>' +
      '<div class="tile"><span class="k">Open pipeline</span><b>' + money(openSum) + '</b><small>' + open.length + ' deals</small></div>' +
      '<div class="tile"><span class="k">Won</span><b>$48,000</b><small>all time</small></div>';
    if (s.overdueTile) h += '<div class="tile new alert"><span class="k">Overdue</span><b>' + money(odSum) + '</b><small>' + od.length + ' customers</small></div>';
    return h;
  }
  function pipelineHtml(s) {
    if (s.bars) {
      var max = 48000;
      var order = ['won', 'qualified', 'proposal'];
      return '<h4>Pipeline by stage</h4><div class="bars">' + order.map(function (st) {
        var sum = data.deals.filter(function (d) { return d.stage === st; }).reduce(function (a, d) { return a + d.amount; }, 0);
        return '<div class="bar"><span class="k">' + st + '</span><i style="--w:' + Math.round(sum / max * 100) + '%"></i><span class="n">' + money(sum) + '</span></div>';
      }).join('') + '</div>';
    }
    return '<h4>Deals</h4><table><thead><tr><th>Title</th><th>Stage</th><th class="n">Amount</th></tr></thead><tbody>' +
      data.deals.map(function (d) {
        return '<tr><td>' + d.title + '</td><td><span class="st ' + d.stage + '">' + d.stage + '</span></td><td class="n">' + money(d.amount) + '</td></tr>';
      }).join('') + '</tbody></table>';
  }
  function customersHtml(s) {
    var list = data.customers.slice();
    if (s.sortOverdue) list.sort(function (a, b) { return (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0); });
    return '<h4>Customers</h4><ul>' + list.map(function (c) {
      var od = s.sortOverdue && c.overdue;
      return '<li><span>' + c.name + '</span><span class="due' + (od ? ' overdue' : '') + '">due ' + c.due + (od ? ' · overdue' : '') + '</span></li>';
    }).join('') + '</ul>';
  }

  function renderState(s, zone) {
    tiles.innerHTML = tilesHtml(s);
    pipeline.innerHTML = pipelineHtml(s);
    customers.innerHTML = customersHtml(s);
    dash.classList.toggle('compact', !!s.compact);
    if (s.bars) requestAnimationFrame(function () { pipeline.classList.add('grown'); });
    else pipeline.classList.remove('grown');
    if (zone) flash(zone);
  }
  // Focus: while a request runs and right after it lands, only the panel it changes stays sharp (Minte, 2026-10-22).
  var focusTimer = null;
  function focus(zone) {
    clearTimeout(focusTimer);
    [tiles, pipeline, customers].forEach(function (el) { el.classList.remove('pane-focus'); });
    if (!zone) { dash.removeAttribute('data-focus'); return; }
    dash.setAttribute('data-focus', zone);
    (zone === 'all' ? [tiles, pipeline, customers] : [root.querySelector('[data-zone="' + zone + '"]')]).forEach(function (el) { el.classList.add('pane-focus'); });
  }
  function unfocusLater(ms) { clearTimeout(focusTimer); focusTimer = setTimeout(function () { focus(null); }, ms); }

  function flash(zone) {
    var els = zone === 'all' ? [tiles, pipeline, customers] : [root.querySelector('[data-zone="' + zone + '"]')];
    els.forEach(function (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); });
  }

  var history = [{ id: 'base', state: {}, label: 'Original version' }];
  var head = 0;
  var busy = false;
  var manual = false;

  function drawRuler() {
    ruler.innerHTML = '';
    var times = ['—', '14:41', '14:42', '14:44', '14:47', '14:52'];
    for (var i = 0; i < history.length; i++) {
      var t = document.createElement('li');
      t.className = 'tick' + (i === head ? ' head' : '') + (i > head ? ' future' : '');
      t.innerHTML = '<span class="v">v' + i + '</span><span>' + (i === 0 ? 'Original' : history[i].label) + '</span><span class="t">' + (i === head ? 'now' : times[i] || '') + '</span>';
      ruler.appendChild(t);
    }
    var n = head;
    verBtn.textContent = n === 0 ? 'Original version' : n + (n === 1 ? ' change' : ' changes');
    verBtn.classList.toggle('on', n > 0);
    ruler.hidden = history.length < 2;
    undoBtn.disabled = head === 0 || busy;
    resetBtn.disabled = head === 0 || busy;
  }

  function setBusy(b) {
    busy = b;
    recipes.forEach(function (r) { r.disabled = b; });
    sendBtn.classList.toggle('on', b);
    sendBtn.textContent = b ? '■' : '↑';
    drawRuler();
  }

  function resetPrompt() {
    text.classList.add('empty');
    text.textContent = PLACEHOLDER;
    cursor.hidden = true;
  }

  function typeInto(str, done) {
    text.classList.remove('empty');
    cursor.hidden = false;
    text.textContent = '';
    if (reduced) { text.textContent = str; return setTimeout(done, 150); }
    var i = 0;
    var iv = setInterval(function () {
      text.textContent = str.slice(0, ++i);
      if (i >= str.length) { clearInterval(iv); setTimeout(done, 260); }
    }, 24);
  }

  function addTurn(request) {
    var u = document.createElement('div');
    u.className = 'u';
    u.textContent = request;
    feed.appendChild(u);
    var live = document.createElement('div');
    live.className = 'live';
    live.innerHTML = '<span class="pulse"></span><span class="step"></span><span class="secs">0.0 s</span>';
    feed.appendChild(live);
    while (feed.children.length > 6) feed.removeChild(feed.firstChild);
    feed.scrollTop = feed.scrollHeight;
    return live;
  }

  // One live line per request: the current step and the elapsed time, like the real drawer.
  function runSteps(live, lines, done) {
    var stepEl = live.querySelector('.step');
    var secsEl = live.querySelector('.secs');
    var start = Date.now();
    var tick = setInterval(function () { secsEl.textContent = ((Date.now() - start) / 1000).toFixed(1) + ' s'; }, 100);
    var i = 0;
    function next() {
      if (i >= lines.length) { clearInterval(tick); return done(((Date.now() - start) / 1000).toFixed(1)); }
      stepEl.classList.remove('swap'); void stepEl.offsetWidth; stepEl.classList.add('swap');
      stepEl.textContent = lines[i++];
      setTimeout(next, reduced ? 60 : 520 + Math.random() * 260);
    }
    next();
  }

  function finish(live, r, secs) {
    var res = document.createElement('div');
    res.className = 'res' + (r.backend ? ' backend' : '');
    res.innerHTML = '<span class="mark">' + (r.backend ? '→' : '✓') + '</span><div><p>' + r.summary + '</p><span class="meta">' + r.lines.length + ' steps · ' + secs + ' s' + (r.backend ? '' : ' · alice only') + '</span></div>';
    feed.replaceChild(res, live);
    feed.scrollTop = feed.scrollHeight;
  }

  function apply(key, done) {
    if (busy) return;
    var r = recipesMap[key];
    var request = root.querySelector('.recipe[data-recipe="' + key + '"]').getAttribute('data-request');
    setBusy(true);
    focus(r.zone || null);
    typeInto(request, function () {
      resetPrompt();
      var live = addTurn(request);
      runSteps(live, r.lines, function (secs) {
        if (!r.backend) {
          var prev = history[head].state;
          var next = {};
          for (var k in prev) next[k] = prev[k];
          for (var k2 in r.set) next[k2] = r.set[k2];
          history = history.slice(0, head + 1);
          history.push({ id: key, state: next, label: r.label });
          head = history.length - 1;
          renderState(next, r.zone);
        }
        finish(live, r, secs);
        setBusy(false);
        unfocusLater(r.backend ? 400 : 2600);
        if (done) done();
      });
    });
  }

  function sys(msg) {
    var d = document.createElement('div');
    d.className = 'sys';
    d.textContent = msg;
    feed.appendChild(d);
    feed.scrollTop = feed.scrollHeight;
  }

  undoBtn.addEventListener('click', function () {
    manual = true;
    if (busy || head === 0) return;
    var zone = recipesMap[history[head].id].zone;
    head--;
    focus(zone); unfocusLater(1800);
    renderState(history[head].state, zone);
    sys('↶ Undone. Back to v' + head + '. One click, no model call.');
    drawRuler();
  });
  resetBtn.addEventListener('click', function () {
    manual = true;
    if (busy || head === 0) return;
    head = 0; history = history.slice(0, 1);
    focus(null);
    renderState({}, 'all');
    sys('Reset to the original version.');
    drawRuler();
  });
  verBtn.addEventListener('click', function () { if (history.length > 1) ruler.hidden = !ruler.hidden; });
  recipes.forEach(function (btn) {
    btn.addEventListener('click', function () { manual = true; apply(btn.getAttribute('data-recipe')); });
  });

  renderState({});
  resetPrompt();
  drawRuler();

  // Autoplay once, when the stage scrolls into view: three requests in a row,
  // so a visitor sees the loop (ask, watch, dashboard changes) without clicking.
  var queue = ['overdue', 'bars', 'sort'];
  function playNext() {
    if (manual || !queue.length) return;
    var key = queue.shift();
    setTimeout(function () { if (!manual) apply(key, function () { setTimeout(playNext, reduced ? 300 : 1600); }); }, 0);
  }
  if (!window.__pleatkitNoAutoplay && !reduced && 'IntersectionObserver' in window) {
    var seen = false;
    var io = new IntersectionObserver(function (entries) {
      if (seen) return;
      if (entries.some(function (e) { return e.isIntersecting; })) { seen = true; io.disconnect(); setTimeout(playNext, 700); }
    }, { threshold: 0.4 });
    io.observe(root);
  }
})();
