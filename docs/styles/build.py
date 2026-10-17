"""Assemble styles-*.json into one gallery page. Usage: python -I build.py <styles_dir> <out_html>"""
import json, sys, html, re, glob, os

src_dir, out = sys.argv[1], sys.argv[2]
styles = []
problems = []
for path in sorted(glob.glob(os.path.join(src_dir, 'styles-*.json'))):
    try:
        data = json.load(open(path, encoding='utf-8'))
    except Exception as e:  # noqa: BLE001
        problems.append(f'{os.path.basename(path)}: {e}')
        continue
    for s in data:
        if not isinstance(s, dict) or 'html' not in s or 'id' not in s:
            problems.append(f'{os.path.basename(path)}: bad entry')
            continue
        # scoping sanity: every CSS rule must be prefixed with .s-<id>
        sid = s['id']
        css = ''.join(re.findall(r'<style[^>]*>(.*?)</style>', s['html'], re.S))
        bad = [sel for sel in re.findall(r'(?:^|})\s*([^{}]+?)\s*{', css) if sel.strip() and not sel.strip().startswith('@') and f'.s-{sid}' not in sel]
        if bad:
            problems.append(f'{sid}: unscoped selectors {bad[:3]}')
        if '<script' in s['html'].lower():
            problems.append(f'{sid}: script tag removed')
            s['html'] = re.sub(r'<script.*?</script>', '', s['html'], flags=re.S | re.I)
        styles.append(s)

fonts = sorted({f for s in styles for f in s.get('fonts', []) if f})
font_link = ''
if fonts:
    font_link = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' + \
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?' + '&'.join('family=' + f for f in fonts) + '&display=swap">'

families = ['paper', 'instruments', 'software', 'engineering', 'graphic']
fam_ru = {'paper': 'Бумага и печать', 'instruments': 'Приборы и железо', 'software': 'История софта', 'engineering': 'Инженерия и карты', 'graphic': 'Графические школы'}

def esc(x):
    return html.escape(str(x), quote=True)

tiles = []
for s in styles:
    pal = ''.join(f'<i style="background:{esc(c)}" title="{esc(c)}"></i>' for c in s.get('palette', [])[:5])
    comps = ', '.join(s.get('components', []))
    t = s.get('type', {})
    tiles.append(f'''
<article class="g-item" data-fam="{esc(s.get('family',''))}" data-id="{esc(s['id'])}" id="{esc(s['id'])}">
  <div class="g-frame">{s['html']}</div>
  <div class="g-meta">
    <div class="g-top"><span class="g-id">{esc(s['id'])}</span><b>{esc(s.get('name',''))}</b><span class="g-pal">{pal}</span></div>
    <div class="g-origin">{esc(s.get('origin',''))}</div>
    <details><summary>почему не ИИ · чем подходит · шрифты · компоненты</summary>
      <p><b>Не ИИ:</b> {esc(s.get('why_not_ai',''))}</p>
      <p><b>Подходит:</b> {esc(s.get('fits',''))}</p>
      <p><b>Шрифты:</b> {esc(t.get('display',''))} / {esc(t.get('body',''))} / {esc(t.get('mono',''))}</p>
      <p><b>Компоненты:</b> {esc(comps)}</p>
    </details>
    <label class="g-pick"><input type="checkbox" data-pick="{esc(s['id'])}"> в шорт-лист</label>
  </div>
</article>''')

chips = ''.join(f'<button class="chip" data-fam="{f}">{fam_ru[f]} <span>{sum(1 for s in styles if s.get("family")==f)}</span></button>' for f in families)
page = f'''<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Style gallery</title>
<meta name="description" content="{len(styles)} направлений дизайна для morphkit: каждое со своими компонентами, палитрой и шрифтами, без ИИ-клише.">
{font_link}
<style>
  :root {{ --bg: #ffffff; --fg: #111; --mute: #666; --line: #ddd; --chip: #f2f2f2; --pick: #ffd500; }}
  @media (prefers-color-scheme: dark) {{ :root:not([data-theme="light"]) {{ --bg: #141414; --fg: #eee; --mute: #999; --line: #333; --chip: #222; }} }}
  :root[data-theme="dark"] {{ --bg: #141414; --fg: #eee; --mute: #999; --line: #333; --chip: #222; }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }}
  header {{ position: sticky; top: 0; z-index: 5; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 16px; display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }}
  header h1 {{ font-size: 16px; margin: 0 12px 0 0; font-weight: 600; }}
  .chip {{ border: 1px solid var(--line); background: var(--chip); color: var(--fg); padding: 6px 10px; border-radius: 999px; cursor: pointer; font: inherit; font-size: 13px; }}
  .chip.on {{ background: var(--fg); color: var(--bg); }}
  .chip span {{ opacity: .6; }}
  header .right {{ margin-left: auto; display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--mute); }}
  .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); gap: 20px; padding: 20px 16px 60px; }}
  .g-item {{ border: 1px solid var(--line); background: var(--bg); display: flex; flex-direction: column; }}
  .g-item.hide {{ display: none; }}
  .g-item.picked {{ outline: 3px solid var(--pick); }}
  .g-frame {{ padding: 10px; display: flex; justify-content: center; background: repeating-conic-gradient(var(--chip) 0 25%, transparent 0 50%) 0 0 / 16px 16px; overflow: hidden; }}
  .g-frame .tile {{ width: 360px; max-width: 100%; }}
  .g-meta {{ padding: 10px 12px 12px; border-top: 1px solid var(--line); font-size: 13px; }}
  .g-top {{ display: flex; gap: 8px; align-items: center; }}
  .g-id {{ font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--mute); }}
  .g-pal {{ margin-left: auto; display: flex; gap: 2px; }}
  .g-pal i {{ display: inline-block; width: 14px; height: 14px; border: 1px solid rgba(0,0,0,.15); }}
  .g-origin {{ color: var(--mute); margin: 4px 0; }}
  details summary {{ cursor: pointer; color: var(--mute); font-size: 12px; }}
  details p {{ margin: 6px 0; }}
  .g-pick {{ display: inline-flex; gap: 6px; align-items: center; margin-top: 6px; font-size: 12px; cursor: pointer; }}
  #shortlist {{ position: fixed; right: 16px; bottom: 16px; z-index: 6; background: var(--fg); color: var(--bg); padding: 10px 14px; border-radius: 6px; font-size: 13px; max-width: 420px; display: none; }}
  #shortlist.on {{ display: block; }}
  #shortlist code {{ user-select: all; }}
  .problems {{ margin: 12px 16px 0; padding: 10px 12px; border: 1px dashed var(--line); color: var(--mute); font-size: 12px; }}
  @media (max-width: 480px) {{ .grid {{ grid-template-columns: minmax(0, 1fr); padding: 12px 16px 60px; }} .g-frame .tile {{ width: 100%; }} }}
</style>
</head>
<body>
<header>
  <h1>Галерея стилей · {len(styles)}</h1>
  <button class="chip on" data-fam="all">Все <span>{len(styles)}</span></button>
  {chips}
  <div class="right"><label><input type="checkbox" id="onlyPicked"> только шорт-лист</label><span id="count"></span></div>
</header>
{('<div class="problems">Замечания сборщика: ' + ' · '.join(esc(p) for p in problems) + '</div>') if problems else ''}
<main class="grid">
{''.join(tiles)}
</main>
<div id="shortlist">Шорт-лист (скопируй мне): <code id="picks"></code></div>
<script>
(function () {{
  var items = Array.prototype.slice.call(document.querySelectorAll('.g-item'));
  var chips = Array.prototype.slice.call(document.querySelectorAll('.chip'));
  var fam = 'all'; var onlyPicked = document.getElementById('onlyPicked');
  var picks = {{}};
  try {{ picks = JSON.parse(localStorage.getItem('style-picks') || '{{}}'); }} catch (e) {{ picks = {{}}; }}
  function render() {{
    var n = 0;
    items.forEach(function (it) {{
      var ok = (fam === 'all' || it.getAttribute('data-fam') === fam) && (!onlyPicked.checked || picks[it.getAttribute('data-id')]);
      it.classList.toggle('hide', !ok); if (ok) n++;
      it.classList.toggle('picked', !!picks[it.getAttribute('data-id')]);
    }});
    document.getElementById('count').textContent = n + ' показано';
    var list = Object.keys(picks).filter(function (k) {{ return picks[k]; }}).sort();
    var box = document.getElementById('shortlist');
    box.classList.toggle('on', list.length > 0);
    document.getElementById('picks').textContent = list.join(', ');
    try {{ localStorage.setItem('style-picks', JSON.stringify(picks)); }} catch (e) {{}}
  }}
  chips.forEach(function (c) {{ c.addEventListener('click', function () {{ chips.forEach(function (x) {{ x.classList.remove('on'); }}); c.classList.add('on'); fam = c.getAttribute('data-fam'); render(); }}); }});
  onlyPicked.addEventListener('change', render);
  Array.prototype.slice.call(document.querySelectorAll('[data-pick]')).forEach(function (cb) {{
    cb.checked = !!picks[cb.getAttribute('data-pick')];
    cb.addEventListener('change', function () {{ picks[cb.getAttribute('data-pick')] = cb.checked; render(); }});
  }});
  render();
}})();
</script>
</body>
</html>'''
os.makedirs(os.path.dirname(out), exist_ok=True)
open(out, 'w', encoding='utf-8').write(page)
print(f'styles={len(styles)} fonts={len(fonts)} problems={len(problems)}')
for p in problems:
    print(' -', p)
