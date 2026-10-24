// Hero stage v5 "motion" (2026-10-24, Minte): one request at a time, large. The customer types the request in big
// type and presses Enter; a few quiet seconds show what the drawer reports; then the one fragment that changed
// appears large and morphs from before to after. Nothing else on the stage. Scripted, no model runs here.
(function () {
  var root = document.querySelector('[data-live]');
  if (!root) return;
  var ask = root.querySelector('.ask');
  var typed = root.querySelector('.ask .typed');
  var caret = root.querySelector('.ask .caret');
  var key = root.querySelector('.ask .key');
  var asked = root.querySelector('.asked');
  var work = root.querySelector('.work');
  var stepsEl = root.querySelector('.work .steps-live');
  var timerEl = root.querySelector('.work .timer');
  var bar = root.querySelector('.work .progress i');
  var reveal = root.querySelector('.reveal');
  var frag = root.querySelector('.reveal .frag');
  var caption = root.querySelector('.reveal .caption');
  var dots = Array.prototype.slice.call(root.querySelectorAll('.dots button'));
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

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

  var scenarios = [
    {
      id: 'overdue',
      ask: 'Add a tile with overdue payments at the top.',
      lines: ['Understanding the request', "Looking at the app's data helpers", 'Adding a tile to the dashboard', 'Checking that everything still works'],
      caption: 'A new tile, only on this customer’s screen. One click to undo.',
      before: tilesHtml(false),
      morph: morphTiles
    },
    {
      id: 'bars',
      ask: 'Show the pipeline by stage as bars instead of the table.',
      lines: ['Understanding the request', 'Changing the deals panel', 'Checking that everything still works'],
      caption: 'Same numbers, a different panel. Every other customer keeps the table.',
      before: tableHtml(),
      morph: morphBars
    },
    {
      id: 'sort',
      ask: 'Put overdue customers first and mark their dates in red.',
      lines: ['Understanding the request', 'Changing the customer list', 'Checking that everything still works'],
      caption: 'Sorted and marked, as asked. Saved as this customer’s version.',
      before: listHtml(),
      morph: morphList
    }
  ];

  // --- fragments ---
  function tileHtml(k, v, s, extra) {
    return '<div class="ftile' + (extra ? ' ' + extra : '') + '"><span class="k">' + k + '</span><b>' + v + '</b><small>' + s + '</small></div>';
  }
  function tilesHtml() {
    return '<div class="ftiles">' + tileHtml('Customers', '4', '2 active') + tileHtml('Open pipeline', '$49,500', '2 deals') + tileHtml('Won', '$48,000', 'all time') + '</div>';
  }
  function tableHtml() {
    return '<div class="fpane"><h4><span class="t1">Deals</span><span class="t2">Pipeline by stage</span></h4><div class="fbody">' +
      '<table class="ftable"><thead><tr><th>Title</th><th>Stage</th><th class="n">Amount</th></tr></thead><tbody>' +
      deals.map(function (d) { return '<tr><td>' + d.title + '</td><td><span class="st ' + d.stage + '">' + d.stage + '</span></td><td class="n">' + money(d.amount) + '</td></tr>'; }).join('') +
      '</tbody></table>' +
      '<div class="fbars">' + ['won', 'qualified', 'proposal'].map(function (st) {
        var sum = deals.filter(function (d) { return d.stage === st; }).reduce(function (a, d) { return a + d.amount; }, 0);
        return '<div class="fbar"><span class="k">' + st + '</span><i style="--w:' + Math.round(sum / 48000 * 100) + '%"></i><span class="n">' + money(sum) + '</span></div>';
      }).join('') + '</div></div></div>';
  }
  function listHtml() {
    return '<div class="fpane"><h4>Customers</h4><ul class="flist">' + customers.map(function (c, i) {
      return '<li data-i="' + i + '" data-od="' + (c.overdue ? 1 : 0) + '"><span>' + c.name + '</span><span class="due">due ' + c.due + '<em> · overdue</em></span></li>';
    }).join('') + '</ul></div>';
  }

  // --- morphs: before is on screen, animate to after, resolve when done ---
  function morphTiles(done) {
    var row = frag.querySelector('.ftiles');
    var t = document.createElement('div');
    t.className = 'ftile alert enter';
    t.innerHTML = '<span class="k">Overdue</span><b>$0</b><small>2 customers</small>';
    row.appendChild(t);
    var b = t.querySelector('b');
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      t.classList.add('in');
      countUp(b, 21500, reduced ? 0 : 800);
      setTimeout(done, reduced ? 50 : 900);
    }); });
  }
  function morphBars(done) {
    var pane = frag.querySelector('.fpane');
    pane.classList.add('to-bars');
    setTimeout(function () { pane.classList.add('grown'); }, reduced ? 0 : 420);
    setTimeout(done, reduced ? 50 : 1300);
  }
  function morphList(done) {
    var ul = frag.querySelector('.flist');
    var items = Array.prototype.slice.call(ul.children);
    var first = {};
    items.forEach(function (li) { first[li.dataset.i] = li.getBoundingClientRect().top; });
    items.sort(function (a, b) { return (+b.dataset.od) - (+a.dataset.od); });
    items.forEach(function (li) { ul.appendChild(li); });
    // FLIP through the Web Animations API: no inline styles left behind, nothing to clean up on the next frame.
    items.forEach(function (li) {
      var dy = first[li.dataset.i] - li.getBoundingClientRect().top;
      if (!reduced && dy && li.animate) li.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 700, easing: 'cubic-bezier(.2,.7,.2,1)' });
    });
    setTimeout(function () { ul.classList.add('marked'); }, reduced ? 0 : 350);
    setTimeout(done, reduced ? 50 : 1100);
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

  function typeInto(str, done) {
    typed.textContent = '';
    if (reduced) { typed.textContent = str; return later(done, 100); }
    var i = 0;
    (function step() {
      typed.textContent = str.slice(0, ++i);
      if (i < str.length) later(step, 26 + Math.random() * 34 + (/[,.]/.test(str[i - 1]) ? 140 : 0));
      else later(done, 520);
    })();
  }

  function runSteps(lines, done) {
    stepsEl.innerHTML = '';
    var start = performance.now();
    var tick = setInterval(function () { timerEl.textContent = ((performance.now() - start) / 1000).toFixed(1) + ' s'; }, 100);
    timers.push(tick);
    var i = 0;
    (function next() {
      if (i >= lines.length) { clearInterval(tick); timerEl.textContent = ((performance.now() - start) / 1000).toFixed(1) + ' s'; return done(); }
      var li = document.createElement('li');
      li.textContent = lines[i++];
      stepsEl.appendChild(li);
      requestAnimationFrame(function () { li.classList.add('in'); });
      if (stepsEl.children.length > 1) stepsEl.children[stepsEl.children.length - 2].classList.add('done');
      later(next, 640);
    })();
  }

  var current = -1;
  var running = false;
  var runId = 0;
  function play(i) {
    clearTimers();
    running = true;
    current = i;
    var my = ++runId;
    // A click on a dot while a run is in flight starts a new run; callbacks of the old one must not touch the stage.
    var guard = function (fn) { return function () { if (my === runId) fn.apply(null, arguments); }; };
    var s = scenarios[i];
    dots.forEach(function (d, j) { d.classList.toggle('on', j === i); });
    root.classList.remove('leave');
    frag.innerHTML = '';
    caption.textContent = '';
    reveal.classList.remove('captioned');
    stepsEl.innerHTML = '';
    timerEl.textContent = '';
    key.classList.remove('press');
    phase('ask');
    later(function () {
      typeInto(s.ask, function () {
        key.classList.add('press');
        later(function () {
          asked.textContent = s.ask;
          phase('between');
          later(function () { phase('work'); }, 300);
          bar.style.transitionDuration = (s.lines.length * 640 + 300) + 'ms';
          later(function () {
            runSteps(s.lines, function () {
              phase('between');
              later(function () {
              frag.innerHTML = s.before;
              phase('reveal');
              later(function () {
                s.morph(guard(function () {
                  caption.textContent = s.caption;
                  reveal.classList.add('captioned');
                  later(function () {
                    root.classList.add('leave');
                    later(function () { reveal.classList.remove('captioned'); play((i + 1) % scenarios.length); }, 520);
                  }, 3200);
                }));
              }, 900);
              }, 380);
            });
          }, 420);
        }, 420);
      });
    }, 500);
  }

  dots.forEach(function (d, j) { d.addEventListener('click', function () { play(j); }); });

  // Start when the stage is in view; the page's screenshots set __pleatkitNoAutoplay and show the final state.
  if (window.__pleatkitNoAutoplay) {
    frag.innerHTML = scenarios[0].before; phase('reveal'); scenarios[0].morph(function () { caption.textContent = scenarios[0].caption; reveal.classList.add('captioned'); });
    dots[0].classList.add('on');
    return;
  }
  function start() { if (!running) play(0); }
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      if (entries.some(function (e) { return e.isIntersecting; })) { io.disconnect(); setTimeout(start, 400); }
    }, { threshold: 0.35 });
    io.observe(root);
  } else start();
})();
