import asyncio, os, subprocess, time, shutil, signal
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP, SW, SH = ':98', 1920, 1080
async def main():
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', f'{SW}x{SH}x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8732'], cwd='/home/claude/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.5); env = dict(os.environ, DISPLAY=DISP)
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', f'--window-size={SW},{SH}', '--autoplay-policy=no-user-gesture-required'])
        pg = await br.new_page(viewport={'width': SW, 'height': SH}); await pg.goto('http://localhost:8732/index.html'); await pg.wait_for_timeout(1000)
        shutil.rmtree('/tmp/slop-ud2', ignore_errors=True)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud2', '--remote-debugging-port=9334', '/home/claude/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1'), stdout=open('/tmp/slop2.log', 'w'), stderr=subprocess.STDOUT)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9334'); break
            except Exception: pass
        await asyncio.sleep(5)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        async def state(label):
            st = await ov.evaluate('window.__slopState()'); k = st['k']
            truth = await pg.evaluate("(() => { const top = window.outerHeight - window.innerHeight + window.screenY; return [...document.querySelectorAll('.media')].map(e => { const r = e.getBoundingClientRect(); return {src: e.getAttribute('src'), x: Math.round(r.left), y: Math.round(r.top + top), h: Math.round(r.height)}; }).filter(r => r.y < %d && r.y + r.h > 0); })()" % SH)
            boxes = [{'x': round(b['x'] / k), 'y': round(b['y'] / k), 'blurred': b['blurred'], 'p': b['p']} for b in st['boxes']]
            print(f"{label}: processing scale {k:.3f} (screen 1920 wide -> {round(1920 * k)} px), boxes {[(b['x'], b['y'], 'blur' if b['blurred'] else 'clear') for b in boxes]}")
            for t in truth:
                m = min(boxes, key=lambda b: abs(b['y'] - t['y']) + abs(b['x'] - t['x']), default=None)
                print(f"   {t['src']:16s} truly at ({t['x']},{t['y']}): " + (f"box off by ({m['x'] - t['x']}, {m['y'] - t['y']})" if m and abs(m['y'] - t['y']) < 60 else 'no box'))
            return boxes
        await state('AT REST')
        await pg.evaluate('window.scrollBy(0, 1500)'); await asyncio.sleep(4)
        await state('AFTER JUMPING 1500 px DOWN (old pictures gone)')
        # the control bar
        bar = await ov.evaluate("(() => { const b = document.querySelector('#bar'); const r = b.getBoundingClientRect(); return {text: b.innerText.replace(/\\n/g, ' '), x: r.left, y: r.top, w: r.width, h: r.height}; })()")
        print('control bar:', bar)
        await ov.evaluate("document.querySelector('#onoff').click()"); await asyncio.sleep(1)
        print('after On/Off click:', await ov.evaluate("document.querySelector('#bar').innerText.replace(/\\n/g, ' ')"), '| saved paused =', open('/tmp/slop-ud2/settings.json').read().count('"paused": true') == 1)
        await ov.evaluate("document.querySelector('#onoff').click()"); await asyncio.sleep(1)
        print('after second click:', await ov.evaluate("document.querySelector('#bar').innerText.replace(/\\n/g, ' ')"))
        await ov.evaluate("document.querySelector('#close').click()"); await asyncio.sleep(2)
        print('after Close: app still running =', el.poll() is None)
        if el.poll() is None: el.send_signal(signal.SIGTERM)
        await br.close()
    srv.terminate(); xvfb.terminate()
    print('--- log:'); print('\n'.join(l for l in open('/tmp/slop2.log').read().splitlines() if any(x in l for x in ['capturing', 'perf', 'error', 'failed']))[-1500:])
asyncio.run(main())
