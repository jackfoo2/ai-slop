import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':92'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8737'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISP)
    shutil.rmtree('/tmp/slop-ud8', ignore_errors=True)
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1080'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1080}); await pg.goto('http://localhost:8737/explorer.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud8', '--remote-debugging-port=9340', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9340'); break
            except Exception: pass
        await asyncio.sleep(12)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        top = await pg.evaluate('window.outerHeight - window.innerHeight + window.screenY')
        async def blurred_items():
            st = await ov.evaluate('window.__slopState()'); k = st['k']
            rects = await pg.evaluate("[...document.querySelectorAll('.media')].map((e, i) => { const r = e.getBoundingClientRect(); return {i, x: r.left, y: r.top, w: r.width, h: r.height}; })")
            out = set()
            for r in rects:
                if r['y'] + top + r['h'] > 1080: continue
                for b in st['boxes']:
                    bx, by, bw, bh = b['x'] / k, b['y'] / k, b['w'] / k, b['h'] / k
                    if b['blurred'] and abs(bx - r['x']) < 14 and abs(by - (r['y'] + top)) < 14 and abs(bw - r['w']) < 20: out.add(r['i'])
            return out, sum(1 for r in rects if r['y'] + top + r['h'] <= 1080)
        got, n = await blurred_items(); print(f'thumbnails fully on screen: {n}, blurred: {len(got)}')
        for item in [2, 9]:
            await pg.evaluate(f"document.querySelectorAll('.it').forEach(e => e.classList.remove('hover')); document.querySelector('#it{item}').classList.add('hover')")
            await asyncio.sleep(4)
            got, n = await blurred_items()
            st2 = await ov.evaluate('window.__slopState()'); k2 = st2['k']
            r = (await pg.evaluate("[...document.querySelectorAll('.media')].map(e => { const r = e.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; })"))[item]
            near = [b for b in st2['boxes'] if abs(b['x'] / k2 - r['x']) < 40 and abs(b['y'] / k2 - (r['y'] + top)) < 60]
            print('   DEBUG boxes near the hovered thumbnail:', [{kk: (round(v / k2) if kk in 'xywh' else v) for kk, v in b.items() if kk != 'p'} for b in near], 'truth', {kk: round(v) for kk, v in r.items()})
            print(f'hover highlight held on thumbnail {item + 1} for 4 s: that one still blurred = {item in got}, total blurred {len(got)} of {n}')
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
asyncio.run(main())
