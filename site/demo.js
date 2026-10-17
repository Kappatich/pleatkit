// Scripted live panel for the landing hero. No model: each recipe is a
// pre-written transformation. Compiling, undo and the version ruler mimic
// what the real runtime does, honestly labelled on the page.
(function () {
  var root = document.querySelector('[data-live]');
  if (!root) return;
  var panel = root.querySelector('.panel');
  var hatch = root.querySelector('.zone-hatch');
  var ruler = root.querySelector('.ruler');
  var text = root.querySelector('.prompt-bar .text');
  var sendBtn = root.querySelector('.prompt-bar .send');
  var progress = root.querySelector('.progress');
  var undoBtn = root.querySelector('[data-undo]');
  var resetBtn = root.querySelector('[data-reset]');
  var recipes = Array.prototype.slice.call(root.querySelectorAll('.recipe'));
  var reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var customer = {
    name: 'Globex Corporation', email: 'hank@globex.example', status: 'active',
    phone: '+1 555 0102', city: 'Springfield', source: 'Referral', due: 'Oct 11, 2026', overdue: true,
    deals: [['Annual licence', '$48,000', 'won'], ['Support upgrade', '$9,500', 'proposal']]
  };

  // Each version is a plain render function: that's what a snapshot is.
  var recipesMap = {
    fields: {
      label: 'phone, city, source',
      lines: ['Understanding the request', 'Changing the customer card', 'Checking that the build passes'],
      render: function () {
        return function (s) {
          return '<div class="title"><b>' + customer.name + '</b><span class="status">' + customer.status + '</span></div>' +
            '<dl><dt>Email</dt><dd>' + customer.email + '</dd>' +
            '<dt>Phone</dt><dd>' + customer.phone + '</dd>' +
            '<dt>City</dt><dd>' + customer.city + '</dd>' +
            '<dt>Source</dt><dd>' + customer.source + '</dd>' +
            '<dt>Next payment</dt><dd' + (s.red && customer.overdue ? ' class="overdue"' : '') + '>' + customer.due + '</dd></dl>' +
            (s.deals ? dealsHtml() : '') + (s.note ? noteHtml() : '');
        };
      },
      set: { fields: true }
    },
    red: { label: 'overdue in red', lines: ['Understanding the request', 'Finding the payment date', 'Checking that the build passes'], set: { red: true } },
    deals: { label: 'deals under the card', lines: ['Understanding the request', 'Looking at the data helpers', 'Adding the deals list', 'Checking that the build passes'], set: { deals: true } },
    compact: { label: 'compact layout', lines: ['Understanding the request', 'Tightening spacing', 'Checking that the build passes'], set: { compact: true } },
    note: { label: 'a notes field', lines: ['Understanding the request', 'Using the free-form meta field', 'Checking that the build passes'], set: { note: true } },
    backend: { label: 'discount computed on the server', lines: ['Understanding the request', 'This needs a change on the server', 'Sent to your admin queue, no code written'], backend: true }
  };
  function dealsHtml() {
    return '<div class="deals">' + customer.deals.map(function (d) {
      return '<div><span>' + d[0] + '</span><span class="' + (d[2] === 'won' ? 'won' : '') + '">' + d[1] + ' · ' + d[2] + '</span></div>';
    }).join('') + '</div>';
  }
  function noteHtml() { return '<div class="note-field">Notes: prefers email before 10:00</div>'; }

  function renderState(s) {
    var html;
    if (s.fields) html = recipesMap.fields.render()(s);
    else html = '<div class="title"><b>' + customer.name + '</b><span class="status">' + customer.status + '</span></div>' +
      '<dl><dt>Email</dt><dd>' + customer.email + '</dd>' +
      '<dt>Next payment</dt><dd' + (s.red && customer.overdue ? ' class="overdue"' : '') + '>' + customer.due + '</dd></dl>' +
      (s.deals ? dealsHtml() : '') + (s.note ? noteHtml() : '');
    panel.innerHTML = html;
    panel.classList.toggle('compact', !!s.compact);
  }

  var history = [{ id: 'base', state: {}, label: 'base' }];
  var head = 0;
  var busy = false;

  function drawRuler() {
    ruler.innerHTML = '';
    var times = ['—', '14:41', '14:42', '14:44', '14:47', '14:52'];
    for (var i = 0; i < history.length; i++) {
      var t = document.createElement('div');
      t.className = 'tick' + (i === head ? ' head' : '');
      var label = i === 0 ? 'Original' : history[i].label.charAt(0).toUpperCase() + history[i].label.slice(1);
      t.innerHTML = '<span class="v">v' + i + '</span><span>' + label + '</span><span class="t">' + (i === head ? 'now' : times[i] || '') + '</span>';
      ruler.appendChild(t);
    }
    undoBtn.disabled = head === 0 || busy;
    resetBtn.disabled = head === 0 || busy;
  }

  function setBusy(b) {
    busy = b;
    recipes.forEach(function (r) { r.disabled = b; });
    drawRuler();
  }

  function typeInto(str, done) {
    text.classList.remove('empty');
    if (sendBtn) sendBtn.classList.add('on');
    text.textContent = '';
    if (reduced) { text.textContent = str; return done(); }
    var i = 0;
    var iv = setInterval(function () {
      text.textContent = str.slice(0, ++i);
      if (i >= str.length) { clearInterval(iv); done(); }
    }, 22);
  }

  function showLines(lines, done) {
    progress.innerHTML = '';
    var i = 0;
    function next() {
      if (i > 0) progress.children[i - 1].classList.remove('now');
      if (i >= lines.length) return done();
      var d = document.createElement('div');
      d.className = 'now';
      d.textContent = lines[i++];
      progress.appendChild(d);
      setTimeout(next, reduced ? 0 : 420);
    }
    next();
  }

  function apply(key) {
    if (busy) return;
    var r = recipesMap[key];
    var request = root.querySelector('.recipe[data-recipe="' + key + '"]').getAttribute('data-request');
    setBusy(true);
    typeInto(request, function () {
      showLines(r.lines, function () {
        if (r.backend) {
          var d = document.createElement('div');
          d.className = 'done';
          d.textContent = 'Needs a change on the server. Sent to your admin; the card is unchanged.'; if (sendBtn) sendBtn.classList.remove('on'); text.classList.add('empty'); text.textContent = 'Describe a change or paste a screenshot';
          progress.appendChild(d);
          setBusy(false);
          return;
        }
        var prev = history[head].state;
        var next = {};
        for (var k in prev) next[k] = prev[k];
        for (var k2 in r.set) next[k2] = r.set[k2];
        history = history.slice(0, head + 1);
        history.push({ id: key, state: next, label: r.label });
        head = history.length - 1;
        renderState(next);
        hatch.classList.remove('flash'); void hatch.offsetWidth; hatch.classList.add('flash');
        var ok = document.createElement('div');
        ok.className = 'done';
        ok.textContent = 'Applied as v' + head + ' for alice only. Scripted here; compiled and signed in the app.'; if (sendBtn) sendBtn.classList.remove('on'); text.classList.add('empty'); text.textContent = 'Describe a change or paste a screenshot';
        progress.appendChild(ok);
        setBusy(false);
      });
    });
  }

  undoBtn.addEventListener('click', function () {
    if (busy || head === 0) return;
    head--;
    renderState(history[head].state);
    hatch.classList.remove('flash'); void hatch.offsetWidth; hatch.classList.add('flash');
    progress.innerHTML = '<div class="done">Back to v' + head + '. Undo is one click, no model call.</div>';
    text.textContent = ''; text.classList.add('empty'); text.textContent = 'Describe a change or paste a screenshot'; if (sendBtn) sendBtn.classList.remove('on');
    drawRuler();
  });
  resetBtn.addEventListener('click', function () {
    if (busy) return;
    head = 0; history = history.slice(0, 1);
    renderState({});
    progress.innerHTML = '<div class="done">Reset to the original.</div>';
    text.classList.add('empty'); text.textContent = 'Describe a change or paste a screenshot'; if (sendBtn) sendBtn.classList.remove('on');
    drawRuler();
  });
  recipes.forEach(function (btn) {
    btn.addEventListener('click', function () { apply(btn.getAttribute('data-recipe')); });
  });

  renderState({});
  drawRuler();
})();
