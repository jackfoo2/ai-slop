import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', ':81', '-screen', '0', '1920x1200x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8746'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=':81'); shutil.rmtree('/tmp/slop-ud19', ignore_errors=True)
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1200'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1200}); await pg.goto('http://localhost:8746/collages.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud19', '--remote-debugging-port=9350', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu5'), stdout=open('/tmp/slop19.log', 'w'), stderr=subprocess.STDOUT)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9350'); break
            except Exception: pass
        await asyncio.sleep(20)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        k = await ov.evaluate('window.__slopState().k')
        for b in await ov.evaluate("window.__slopState().boxes.map(b => ({y: b.y, w: b.w, h: b.h, p: b.p, blurred: b.blurred}))"):
            print(f"picture at y={round(b['y'] / k)} ({round(b['w'] / k)}x{round(b['h'] / k)}): score {None if b['p'] is None else round(b['p'], 2)}, blurred {b['blurred']}")
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
    print('log:', [l[25:140] for l in open('/tmp/slop19.log').read().splitlines() if 'collage' in l])
asyncio.run(main())
