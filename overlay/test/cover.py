import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':89'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8741'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISP); shutil.rmtree('/tmp/slop-ud11', ignore_errors=True)
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1080'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1080}); await pg.goto('http://localhost:8741/explorer.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud11', '--remote-debugging-port=9343', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu5'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9343'); break
            except Exception: pass
        await asyncio.sleep(14)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        top = await pg.evaluate('window.outerHeight - window.innerHeight + window.screenY')
        tm = {'x': 120, 'y': 150 + top, 'w': 900, 'h': 560}
        async def count(label):
            st = await ov.evaluate('window.__slopState()'); k = st['k']
            under = lambda b: b['x'] / k < tm['x'] + tm['w'] and (b['x'] + b['w']) / k > tm['x'] and b['y'] / k < tm['y'] + tm['h'] and (b['y'] + b['h']) / k > tm['y']
            bl = [b for b in st['boxes'] if b['blurred']]
            dr = await ov.evaluate('window.__slopDrawn()')
            ov_area = sum(max(0, min(x + w, tm['x'] + tm['w']) - max(x, tm['x'])) * max(0, min(y + h, tm['y'] + tm['h']) - max(y, tm['y'])) for x, y, w, h in dr)
            inside_tm = [b for b in bl if b['x'] / k >= tm['x'] - 4 and (b['x'] + b['w']) / k <= tm['x'] + tm['w'] + 4 and b['y'] / k >= tm['y'] - 4 and (b['y'] + b['h']) / k <= tm['y'] + tm['h'] + 4]
            if inside_tm: print('   blurred things found INSIDE the window:', [(round(b['w'] / k), round(b['h'] / k), round(b['p'], 2)) for b in inside_tm])
            print(f"{label}: {len(bl)} pictures blurred | blur landing on the 'Task Manager' window: {ov_area / (tm['w'] * tm['h']) * 100:.1f}% of it")
        await count('folder open')
        st0 = await ov.evaluate('window.__slopState()'); SNAP0 = {(b['x'], b['y']): (b['w'], b['h'], None if b['p'] is None else round(b['p'], 3)) for b in st0['boxes']}
        for d in (40, 40, -40, -40): await pg.mouse.wheel(0, d); await asyncio.sleep(1.3)
        await asyncio.sleep(2); await count('scrolled a little and back')
        await pg.evaluate("document.querySelector('#taskmgr').style.display = 'block'"); await asyncio.sleep(3)
        await count("'Task Manager' opened on top")
        await pg.evaluate("document.querySelector('#taskmgr').style.display = 'none'"); await asyncio.sleep(3)
        await count("'Task Manager' closed")
        await asyncio.sleep(4); await count('4 s after that')
        await asyncio.sleep(6); await count('10 s after that')
        st = await ov.evaluate('window.__slopState()')
        for b in st['boxes']:
            if not b['blurred']:
                near = [(k, v) for k, v in SNAP0.items() if abs(k[0] - b['x']) < 30 and abs(k[1] - b['y']) < 30]
                print('   BEFORE Task Manager, same spot:', near, '| AFTER:', (b['x'], b['y']), (b['w'], b['h'], None if b['p'] is None else round(b['p'], 3)))
        print('   not blurred:', [{kk: v for kk, v in b.items() if kk in ('y', 'x', 'covered', 'dynamic', 'isScoring', 'nextIn', 'hist')} for b in st['boxes'] if not b['blurred']], '| level', st['level'], '| scoring now', st['scoringNow'])
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
asyncio.run(main())
