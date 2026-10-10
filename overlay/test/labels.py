import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':91'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8739'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISP)
    shutil.rmtree('/tmp/slop-ud9', ignore_errors=True)
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1080'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1080}); await pg.goto('http://localhost:8739/labels.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud9', '--remote-debugging-port=9341', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1'), stdout=open('/tmp/slop9.log', 'w'), stderr=subprocess.STDOUT)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9341'); break
            except Exception: pass
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        top = await pg.evaluate('window.outerHeight - window.innerHeight + window.screenY')
        rects = await pg.evaluate("[...document.querySelectorAll('.media')].map((e, i) => { const r = e.getBoundingClientRect(); return {i, x: r.left, y: r.top}; })")
        t0 = time.time()
        while time.time() - t0 < 60:
            await asyncio.sleep(3)
            ui = await ov.evaluate('window.__slopUI()'); st = await ov.evaluate('window.__slopState()')
            done = sum(1 for t in ui['texts'] if t['done'])
            if done >= 6: break
        k = st['k']; names = ['AI info label', '#aiart caption', 'Imagined with AI', 'KLING AI', 'normal post', '"Is this real?"']
        for r in rects:
            b = next((b for b in st['boxes'] if abs(b['x'] / k - r['x']) < 16 and abs(b['y'] / k - (r['y'] + top)) < 16), None)
            t = next((t for t in ui['texts'] if b and abs(t['y'] - b['y'] / k) < 2), None)
            print(f"post {r['i'] + 1} ({names[r['i']]}): model score {round(b['p'], 2) if b and b['p'] is not None else '-'}, text found {t['hit'] if t else '-'}, BLURRED {b['blurred'] if b else '-'}")
        print('chips:', ui['chips'])
        print(f'all six read in {round(time.time() - t0)} s, {ui["ocrAvgMs"]} ms per text area here')
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
    print('log:', [l[25:150] for l in open('/tmp/slop9.log').read().splitlines() if 'text' in l][:8])
asyncio.run(main())
