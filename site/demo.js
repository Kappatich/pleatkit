// Hero stage v5.4 "motion" (2026-10-24): one request at a time, large. The customer's line types in big type and
// Enter is pressed; the line moves to the top and the steps run under it; the small preview of the fragment grows
// and morphs from before to after; the viewer can press Undo to see the screen as it was (the loop pauses) and
// Redo to apply the change again; at the end everything is drawn into the dot that stores this request.
// Scripted, no model runs here.
(function () {
  var root = document.querySelector('[data-live]');
  if (!root) return;
  var askBlock = root.querySelector('.ask-block');
  var typed = root.querySelector('.ask-text .typed');
  var key = root.querySelector('.ask-hint .key');
  var stepsEl = root.querySelector('.work .steps-live');
  var timerEl = root.querySelector('.work .timer');
  var bar = root.querySelector('.work .progress i');
  var progress = root.querySelector('.work .progress');
  var reveal = root.querySelector('.scene.reveal');
  var frag = root.querySelector('.reveal .frag');
  var caption = root.querySelector('.reveal .caption');
  var undoBtn = root.querySelector('.ur .undo');
  var redoBtn = root.querySelector('.ur .redo');
  var dots = Array.prototype.slice.call(root.querySelectorAll('.dots button'));
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canAnimate = !reduced && typeof askBlock.animate === 'function';
  var HOLD = 5200;        // how long a result stays before the stage moves on
  var HOLD_AFTER_REDO = 4200;

  var customers = [
    { name: 'Globex Corporation', due: 'Oct 11', overdue: true, amount: 12000 },
    { name: 'Initech', due: 'Oct 29', overdue: false, amount: 4500 },
    { name: 'Umbrella Health', due: 'Oct 16', overdue: true, amount: 9500 },
    { name: 'Stark Logistics', due: 'Nov 16', overdue: false, amount: 7200 }
  ];
  var deals = [
    { title: 'Annual licence', stage: 'won', amount: 48000 },
    { title: 'Onboarding package', stage: 'qualified', amount: 40000 },
    { title: 'Support upgrade', stage: 'proposal', amount: 9500 }
  ];
  function money(n) { return '$' + n.toLocaleString('en-US'); }
  // revenue by month, in thousands; the last three are the forecast
  var months = [['May', 42], ['Jun', 38], ['Jul', 55], ['Aug', 49], ['Sep', 64]];
  var forecast = [['Oct', 68], ['Nov', 72], ['Dec', 77]];

  var scenarios = [
    {
      ask: 'Add a tile with overdue payments at the top.',
      lines: ['Understanding the request', "Looking at the app's data helpers", 'Adding a tile to the dashboard', 'Checking that everything still works'],
      caption: 'A new tile, only on this customer’s screen. One click to undo.',
      undone: 'The screen as it was. The change is kept in history; Redo brings it back.',
      before: tilesHtml, morph: morphTiles, revert: revertTiles
    },
    {
      ask: 'Show the pipeline by stage as bars instead of the table.',
      lines: ['Understanding the request', 'Reading the deals table', 'Changing the deals panel', 'Checking that everything still works'],
      caption: 'Same numbers, a different panel. Every other customer keeps the table.',
      undone: 'The table is back, exactly as before. Nothing was lost.',
      before: tableHtml, morph: morphBars, revert: revertBars
    },
    {
      ask: 'Put overdue customers first and mark their dates in red.',
      lines: ['Understanding the request', 'Changing the customer list', 'Checking that everything still works'],
      caption: 'Sorted and marked, as asked. Saved as this customer’s version.',
      undone: 'The original order. One click, and the version is back.',
      before: listHtml, morph: morphList, revert: revertList
    },
    {
      ask: 'Turn the deals table into a monthly revenue chart with a three-month forecast and mark the best month.',
      lines: ['Understanding the request', 'Reading five months of deals', 'Building the chart and the forecast', 'Checking that everything still works'],
      caption: 'A chart with a forecast, built from the same deals. Only on this customer\u2019s screen.',
      undone: 'The table is back. The chart stays in history.',
      before: chartHtml, morph: morphChart, revert: revertChart
    }
  ];

  // --- fragments ---
  function tileHtml(k, v, s, extra) {
    return '<div class="ftile' + (extra ? ' ' + extra : '') + '"><span class="k">' + k + '</span><b>' + v + '</b><small>' + s + '</small></div>';
  }
  function tilesHtml() {
    return '<div class="ftiles">' + tileHtml('Customers', '4', '2 active') + tileHtml('Open pipeline', '$49,500', '2 deals') + tileHtml('Won', '$48,000', 'all time') + '</div>';
  }
  // The deals panel is one grid whose columns animate: the title column shrinks into a stage label, the stage
  // column widens and its pill gives way to a bar, the amount never moves. The same DOM before and after.
  function tableHtml() {
    var order = { won: 0, qualified: 1, proposal: 2 };
    var rows = deals.slice().sort(function (a, b) { return order[a.stage] - order[b.stage]; });
    return '<div class="fpane"><h4><span class="t1">Deals</span><span class="t2">Pipeline by stage</span></h4><div class="fgrid">' +
      '<div class="r h"><span class="c1"><em class="a">Title</em><em class="b">Stage</em></span><span class="c2"><em class="a">Stage</em></span><span class="c3">Amount</span></div>' +
      rows.map(function (d) {
        return '<div class="r"><span class="c1"><em class="a">' + d.title + '</em><em class="b">' + d.stage + '</em></span>' +
          '<span class="c2"><span class="st ' + d.stage + '">' + d.stage + '</span><i class="bar" style="--w:' + Math.round(d.amount / 48000 * 100) + '%"></i></span>' +
          '<span class="c3 n">' + money(d.amount) + '</span></div>';
      }).join('') + '</div></div>';
  }
  // The months table and the chart share one body; the rows fold away while the bars grow out of the baseline.
  function chartHtml() {
    var W = 720, H = 220, base = 180, slot = W / 8, bw = 40, max = 80, k = 140 / max;
    var all = months.concat(forecast);
    var bars = all.map(function (m, i) {
      var x = Math.round(slot * i + (slot - bw) / 2), h = Math.round(m[1] * k), y = base - h;
      var fc = i >= months.length;
      return '<rect class="cbar' + (fc ? ' fc' : '') + (m[0] === 'Sep' ? ' best' : '') + '" x="' + x + '" y="' + y + '" width="' + bw + '" height="' + h + '" rx="3" style="--d:' + (i * 90) + 'ms"/>' +
        '<text class="cm" x="' + (x + bw / 2) + '" y="' + (base + 22) + '" style="--d:' + (i * 90 + 300) + 'ms">' + m[0] + '</text>';
    }).join('');
    var pts = all.slice(months.length - 1).map(function (m, i) { var idx = months.length - 1 + i; return Math.round(slot * idx + slot / 2) + ',' + Math.round(base - m[1] * k); }).join(' ');
    var bx = Math.round(slot * 4 + slot / 2);
    return '<div class="fpane chart"><h4><span class="t1">Deals</span><span class="t2">Revenue by month</span></h4><div class="cbody">' +
      '<table class="ctable"><tbody>' + months.map(function (m, i) { return '<tr style="--d:' + (i * 70) + 'ms"><td>' + m[0] + ' 2026</td><td>' + (m[1] * 7) + ' deals closed</td><td class="n">$' + m[1] + ',000</td></tr>'; }).join('') + '</tbody></table>' +
      '<svg class="csvg" viewBox="0 0 ' + W + ' ' + H + '" aria-hidden="true">' +
      '<line class="caxis" x1="20" y1="' + base + '" x2="' + (W - 20) + '" y2="' + base + '" pathLength="1"/>' + bars +
      '<polyline class="cfc" points="' + pts + '" pathLength="1"/>' +
      '<text class="cbest" x="' + bx + '" y="' + (base - Math.round(64 * k) - 12) + '"><tspan class="cv">$0k</tspan><tspan class="cl"> best</tspan></text>' +
      '<text class="cnote" x="' + Math.round(slot * 6.5) + '" y="28">forecast</text>' +
      '</svg></div></div>';
  }
  function morphChart(done) {
    var pane = frag.querySelector('.fpane.chart');
    pane.classList.add('to-chart');
    var v = pane.querySelector('.cv');
    setTimeout(function () {
      if (reduced) { v.textContent = '$64k'; return; }
      var start = performance.now();
      (function tick(now) {
        var p = Math.min(1, (now - start) / 900); p = 1 - Math.pow(1 - p, 3);
        v.textContent = '$' + Math.round(64 * p) + 'k';
        if (p < 1) requestAnimationFrame(tick);
      })(start);
    }, reduced ? 0 : 1300);
    setTimeout(done, reduced ? 50 : 3200);
  }
  function revertChart(done) {
    var pane = frag.querySelector('.fpane.chart');
    pane.classList.remove('to-chart');
    pane.querySelector('.cv').textContent = '$0k';
    setTimeout(done, reduced ? 50 : 1600);
  }
  function listHtml() {
    return '<div class="fpane"><h4>Customers</h4><ul class="flist">' + customers.map(function (c, i) {
      return '<li data-i="' + i + '" data-od="' + (c.overdue ? 1 : 0) + '"><span>' + c.name + '</span><span class="due">due ' + c.due + '<em> · overdue</em></span></li>';
    }).join('') + '</ul></div>';
  }

  // --- morphs and their reverse; each calls done when the eye has settled ---
  function morphTiles(done) {
    var row = frag.querySelector('.ftiles');
    var old = row.querySelector('.ftile.enter'); if (old) old.remove();
    var t = document.createElement('div');
    t.className = 'ftile alert enter';
    t.innerHTML = '<span class="k">Overdue</span><b>$0</b><small>2 customers</small>';
    row.appendChild(t);
    var b = t.querySelector('b');
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      t.classList.add('in');
      setTimeout(function () { countUp(b, 21500, reduced ? 0 : 1400); }, reduced ? 0 : 400);
      setTimeout(function () { t.classList.add('lit'); }, reduced ? 0 : 1700);
      setTimeout(done, reduced ? 50 : 2400);
    }); });
  }
  function revertTiles(done) {
    var t = frag.querySelector('.ftile.enter');
    if (!t) return done();
    t.classList.remove('in', 'lit');
    setTimeout(function () { t.remove(); done(); }, reduced ? 50 : 1200);
  }
  function morphBars(done) {
    var pane = frag.querySelector('.fpane');
    pane.classList.add('to-bars');
    setTimeout(done, reduced ? 50 : 2600);
  }
  function revertBars(done) {
    frag.querySelector('.fpane').classList.remove('to-bars');
    setTimeout(done, reduced ? 50 : 1800);
  }
  function flipList(sorter, done, settle) {
    var ul = frag.querySelector('.flist');
    var items = Array.prototype.slice.call(ul.children);
    var first = {};
    items.forEach(function (li) { first[li.dataset.i] = li.getBoundingClientRect().top; });
    items.sort(sorter);
    items.forEach(function (li) { ul.appendChild(li); });
    items.forEach(function (li, k) {
      var dy = first[li.dataset.i] - li.getBoundingClientRect().top;
      if (canAnimate && dy) li.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 1100, delay: k * 60, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
    });
    setTimeout(settle, reduced ? 0 : 1000);
    setTimeout(done, reduced ? 50 : 2400);
  }
  function morphList(done) {
    flipList(function (a, b) { return (+b.dataset.od) - (+a.dataset.od); }, done, function () { frag.querySelector('.flist').classList.add('marked'); });
  }
  function revertList(done) {
    frag.querySelector('.flist').classList.remove('marked');
    flipList(function (a, b) { return (+a.dataset.i) - (+b.dataset.i); }, done, function () {});
  }
  function countUp(el, to, ms) {
    if (!ms) { el.textContent = money(to); return; }
    var start = performance.now();
    (function tick(now) {
      var p = Math.min(1, (now - start) / ms); p = 1 - Math.pow(1 - p, 3);
      el.textContent = money(Math.round(to * p / 100) * 100);
      if (p < 1) requestAnimationFrame(tick);
    })(start);
  }

  // --- phases ---
  var timers = [];
  function later(fn, ms) { var t = setTimeout(fn, reduced ? Math.min(ms, 120) : ms); timers.push(t); return t; }
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }
  function phase(name) { root.setAttribute('data-phase', name); }

  // In the ask phase the line sits in the middle of the space above the preview; the drop is measured.
  function measureDrop() {
    root.style.setProperty('--drop', '0px');
    var askRect = askBlock.getBoundingClientRect(), fragRect = frag.getBoundingClientRect();
    var drop = Math.max(0, (fragRect.top - askRect.bottom) / 2 - 12);
    root.style.setProperty('--drop', drop + 'px');
  }
  window.addEventListener('resize', measureDrop);

  function typeInto(str, done) {
    typed.textContent = '';
    if (reduced) { typed.textContent = str; return later(done, 100); }
    var i = 0;
    (function step() {
      typed.textContent = str.slice(0, ++i);
      if (i < str.length) later(step, 20 + Math.random() * 26 + (/[,.]/.test(str[i - 1]) ? 120 : 0));
      else later(done, 700);
    })();
  }

  function runSteps(lines, done) {
    stepsEl.innerHTML = '';
    var start = performance.now();
    var tick = setInterval(function () { timerEl.textContent = ((performance.now() - start) / 1000).toFixed(1) + ' s'; }, 100);
    timers.push(tick);
    var i = 0;
    function finish(k) {   // step k is done: its dot turns green and the line fills to that step
      stepsEl.children[k].classList.add('done');
      bar.style.width = Math.round((k + 1) / lines.length * 100) + '%';
    }
    (function next() {
      if (i >= lines.length) {
        clearInterval(tick); timerEl.textContent = ((performance.now() - start) / 1000).toFixed(1) + ' s';
        finish(lines.length - 1); progress.classList.add('ok');
        return later(done, 600);
      }
      var li = document.createElement('li');
      li.textContent = lines[i++];
      stepsEl.appendChild(li);
      requestAnimationFrame(function () { li.classList.add('in'); });
      if (i > 1) finish(i - 2);
      later(next, 820);
    })();
  }

  // Everything on the stage is drawn into the dot that stores this request.
  function suckInto(i, done) {
    var dot = dots[i].querySelector('span').getBoundingClientRect();
    var parts = [askBlock, frag, caption];
    if (!canAnimate) { parts.forEach(function (el) { el.style.opacity = '0'; }); return later(function () { parts.forEach(function (el) { el.style.opacity = ''; }); done(); }, 150); }
    var anims = parts.map(function (el) {
      var r = el.getBoundingClientRect();
      var dx = dot.left + dot.width / 2 - (r.left + r.width / 2), dy = dot.top + dot.height / 2 - (r.top + r.height / 2);
      return el.animate([
        { transform: 'none', opacity: 1, offset: 0 },
        { transform: 'translate(' + dx * .15 + 'px,' + dy * .1 + 'px) scale(.92)', opacity: .9, offset: .3 },
        { transform: 'translate(' + dx + 'px,' + dy + 'px) scale(.04)', opacity: 0, offset: 1 }
      ], { duration: 720, easing: 'cubic-bezier(.6,0,.9,.4)', fill: 'forwards', composite: el === askBlock ? 'add' : 'replace' });
    });
    later(function () {
      dots[i].classList.add('stored');
      dots[i].querySelector('span').animate([{ transform: 'scale(1.25)' }, { transform: 'scale(2.1)' }, { transform: 'scale(1.25)' }], { duration: 420, easing: 'ease-out' });
      later(function () { anims.forEach(function (a) { a.cancel(); }); done(); }, 320);
    }, 700);
  }

  // --- the run ---
  var running = false;
  var runId = 0;
  var cur = null;   // { i, s, my, state: 'applied' | 'undone' | 'busy' }

  function setButtons(state) {
    reveal.classList.toggle('done', state === 'applied' || state === 'undone');
    undoBtn.hidden = state !== 'applied';
    redoBtn.hidden = state !== 'undone';
  }
  function scheduleAdvance(ms) {
    var c = cur;
    later(function () {
      if (!c || c.my !== runId) return;
      c.state = 'busy'; setButtons('busy');
      suckInto(c.i, function () { if (c.my !== runId) return; reveal.classList.remove('captioned'); play((c.i + 1) % scenarios.length); });
    }, ms);
  }

  function play(i) {
    clearTimers();
    running = true;
    var my = ++runId;
    var guard = function (fn) { return function () { if (my === runId) fn.apply(null, arguments); }; };
    var s = scenarios[i];
    cur = { i: i, s: s, my: my, state: 'busy' };
    dots.forEach(function (d, j) { d.classList.toggle('on', j === i); });
    setButtons('busy');
    // a clean slate before the ask phase shows: no ghost of the previous request or fragment
    typed.textContent = '';
    frag.innerHTML = s.before();   // the preview of what will change is on screen from the first second
    frag.classList.add('small');
    frag.classList.remove('editing');
    caption.textContent = '';
    reveal.classList.remove('captioned');
    stepsEl.innerHTML = '';
    timerEl.textContent = '';
    key.classList.remove('press');
    bar.style.width = '0';
    progress.classList.remove('ok');
    measureDrop();
    phase('ask');
    later(function () {
      typeInto(s.ask, guard(function () {
        key.classList.add('press');
        later(function () {
          phase('sent');          // Enter pressed: the line stays put for a moment, the reader finishes it
          later(function () {
            phase('work');        // the line moves to the top, the steps run under it
            later(function () {
              runSteps(s.lines, guard(function () {
                phase('between');
                later(function () {
                  phase('reveal');
                  frag.classList.remove('small');   // the preview grows to full size
                  frag.classList.add('editing');
                  later(function () {
                    frag.classList.remove('editing');
                    s.morph(guard(function () {
                      caption.textContent = s.caption;
                      reveal.classList.add('captioned');
                      cur.state = 'applied'; setButtons('applied');
                      scheduleAdvance(HOLD);
                    }));
                  }, 1300);
                }, 300);
              }));
            }, 650);
          }, 1000);
        }, 260);
      }));
    }, 350);
  }

  // Undo shows the screen as it was and pauses the loop; Redo applies the change again and the loop resumes.
  undoBtn.addEventListener('click', function () {
    if (!cur || cur.state !== 'applied') return;
    clearTimers();
    var c = cur; c.state = 'busy'; setButtons('busy');
    caption.textContent = c.s.undone;
    c.s.revert(function () { if (c.my !== runId) return; c.state = 'undone'; setButtons('undone'); });
  });
  redoBtn.addEventListener('click', function () {
    if (!cur || cur.state !== 'undone') return;
    var c = cur; c.state = 'busy'; setButtons('busy');
    caption.textContent = '';
    frag.classList.add('editing');
    later(function () {
      frag.classList.remove('editing');
      c.s.morph(function () { if (c.my !== runId) return; caption.textContent = c.s.caption; c.state = 'applied'; setButtons('applied'); scheduleAdvance(HOLD_AFTER_REDO); });
    }, 700);
  });

  dots.forEach(function (d, j) { d.addEventListener('click', function () { play(j); }); });

  if (window.__pleatkitNoAutoplay) {
    typed.textContent = scenarios[0].ask; frag.innerHTML = scenarios[0].before(); frag.classList.remove('small'); phase('reveal'); measureDrop();
    scenarios[0].morph(function () { caption.textContent = scenarios[0].caption; reveal.classList.add('captioned'); });
    dots[0].classList.add('on');
    return;
  }
  measureDrop();
  function start() { if (!running) play(0); }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); setTimeout(start, 400); }
    }, { threshold: 0.35 });
    io.observe(root);
  } else start();
})();
