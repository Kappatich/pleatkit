// Hero stage v5.2 "motion" (2026-10-24, Minte's notes): one request at a time, large. The customer's line types
// in big type, Enter is pressed, the line stays large and moves to the top while the steps run below it; then the
// one fragment that changed appears and morphs from before to after; at the end everything is drawn into the dot
// at the bottom that stores this request, so the dots read as the place to replay. Scripted, no model runs here.
(function () {
  var root = document.querySelector('[data-live]');
  if (!root) return;
  var askBlock = root.querySelector('.ask-block');
  var typed = root.querySelector('.ask-text .typed');
  var key = root.querySelector('.ask-hint .key');
  var stepsEl = root.querySelector('.work .steps-live');
  var timerEl = root.querySelector('.work .timer');
  var bar = root.querySelector('.work .progress i');
  var reveal = root.querySelector('.scene.reveal');
  var frag = root.querySelector('.reveal .frag');
  var caption = root.querySelector('.reveal .caption');
  var dots = Array.prototype.slice.call(root.querySelectorAll('.dots button'));
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var canAnimate = !reduced && typeof askBlock.animate === 'function';

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
      ask: 'Add a tile with overdue payments at the top.',
      lines: ['Understanding the request', "Looking at the app's data helpers", 'Adding a tile to the dashboard', 'Checking that everything still works'],
      caption: 'A new tile, only on this customer’s screen. One click to undo.',
      before: tilesHtml, morph: morphTiles
    },
    {
      ask: 'Show the pipeline by stage as bars instead of the table.',
      lines: ['Understanding the request', 'Reading the deals table', 'Changing the deals panel', 'Checking that everything still works'],
      caption: 'Same numbers, a different panel. Every other customer keeps the table.',
      before: tableHtml, morph: morphBars
    },
    {
      ask: 'Put overdue customers first and mark their dates in red.',
      lines: ['Understanding the request', 'Changing the customer list', 'Checking that everything still works'],
      caption: 'Sorted and marked, as asked. Saved as this customer’s version.',
      before: listHtml, morph: morphList
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
    var order = ['won', 'qualified', 'proposal'];
    return '<div class="fpane"><h4><span class="t1">Deals</span><span class="t2">Pipeline by stage</span></h4><div class="fbody">' +
      '<table class="ftable"><thead><tr><th><span class="t1">Title</span><span class="t2">Stage</span></th><th><span class="t1">Stage</span></th><th class="n">Amount</th></tr></thead><tbody>' +
      deals.map(function (d) { return '<tr><td class="tt">' + d.title + '</td><td class="ts"><span class="st ' + d.stage + '">' + d.stage + '</span></td><td class="n">' + money(d.amount) + '</td></tr>'; }).join('') +
      '</tbody></table>' +
      '<div class="fbars">' + order.map(function (st) {
        var sum = deals.filter(function (d) { return d.stage === st; }).reduce(function (a, d) { return a + d.amount; }, 0);
        return '<div class="fbar"><span class="k">' + st + '</span><i style="--w:' + Math.round(sum / 48000 * 100) + '%"></i><span class="n">' + money(sum) + '</span></div>';
      }).join('') + '</div></div></div>';
  }
  function listHtml() {
    return '<div class="fpane"><h4>Customers</h4><ul class="flist">' + customers.map(function (c, i) {
      return '<li data-i="' + i + '" data-od="' + (c.overdue ? 1 : 0) + '"><span>' + c.name + '</span><span class="due">due ' + c.due + '<em> · overdue</em></span></li>';
    }).join('') + '</ul></div>';
  }

  // --- morphs: the "before" is on screen; animate to "after"; call done when the eye has settled ---
  function morphTiles(done) {
    var row = frag.querySelector('.ftiles');
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
  // Each table row turns into its bar in place: the stage pill folds, the title slides left, the bar grows out of
  // the row, the amount reappears at the end of the bar. Rows go one after another.
  function morphBars(done) {
    var pane = frag.querySelector('.fpane');
    var rows = Array.prototype.slice.call(pane.querySelectorAll('tbody tr'));
    pane.classList.add('to-bars');
    rows.forEach(function (tr, i) { setTimeout(function () { tr.classList.add('fold'); }, reduced ? 0 : 150 + i * 380); });
    setTimeout(function () { pane.classList.add('grown'); }, reduced ? 0 : 500);
    setTimeout(done, reduced ? 50 : 2600);
  }
  function morphList(done) {
    var ul = frag.querySelector('.flist');
    var items = Array.prototype.slice.call(ul.children);
    var first = {};
    items.forEach(function (li) { first[li.dataset.i] = li.getBoundingClientRect().top; });
    items.sort(function (a, b) { return (+b.dataset.od) - (+a.dataset.od); });
    items.forEach(function (li) { ul.appendChild(li); });
    items.forEach(function (li) {
      var dy = first[li.dataset.i] - li.getBoundingClientRect().top;
      if (canAnimate && dy) li.animate([{ transform: 'translateY(' + dy + 'px)' }, { transform: 'none' }], { duration: 1100, delay: +li.dataset.od ? 0 : 140, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
    });
    setTimeout(function () { ul.classList.add('marked'); }, reduced ? 0 : 1000);
    setTimeout(done, reduced ? 50 : 2400);
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

  // In the ask phase the line sits in the middle of the stage; the drop is measured, so the move up is one transform.
  function measureDrop() {
    // centre the request in the space between the top of the stage and the small preview of the fragment
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
    (function next() {
      if (i >= lines.length) { clearInterval(tick); timerEl.textContent = ((performance.now() - start) / 1000).toFixed(1) + ' s'; return later(done, 500); }
      var li = document.createElement('li');
      li.textContent = lines[i++];
      stepsEl.appendChild(li);
      requestAnimationFrame(function () { li.classList.add('in'); });
      if (stepsEl.children.length > 1) stepsEl.children[stepsEl.children.length - 2].classList.add('done');
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

  var running = false;
  var runId = 0;
  function play(i) {
    clearTimers();
    running = true;
    var my = ++runId;
    var guard = function (fn) { return function () { if (my === runId) fn.apply(null, arguments); }; };
    var s = scenarios[i];
    dots.forEach(function (d, j) { d.classList.toggle('on', j === i); });
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
    bar.style.transitionDuration = '0ms';
    measureDrop();
    phase('ask');
    later(function () {
      typeInto(s.ask, guard(function () {
        key.classList.add('press');
        later(function () {
          phase('sent');          // Enter pressed: the line stays put for a moment, the reader finishes it
          later(function () {
            phase('work');        // the line moves to the top, the steps run under it
            bar.style.transitionDuration = (s.lines.length * 820 + 600) + 'ms';
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
                      later(function () {
                        suckInto(i, guard(function () {
                          reveal.classList.remove('captioned');
                          play((i + 1) % scenarios.length);
                        }));
                      }, 3000);
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
