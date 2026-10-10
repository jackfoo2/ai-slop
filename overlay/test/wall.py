import asyncio, os, subprocess, time, shutil, json, sys
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':90'
async def run(ignore):
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server', '^display']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    env = dict(os.environ, DISPLAY=DISP)
    subprocess.run(['display', '-window', 'root', '/tmp/wall.jpg'], env=env, timeout=20)   # the desktop wallpaper
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8740'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    ud = '/tmp/slop-ud10'; shutil.rmtree(ud, ignore_errors=True); os.makedirs(ud); json.dump({'ignoreWallpaper': ignore}, open(f'{ud}/settings.json', 'w'))
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--window-position=560,300', '--window-size=760,560'])
        pg = await br.new_page(viewport=None); await pg.goto('http://localhost:8740/index.html'); await pg.wait_for_timeout(1000)
        win = await pg.evaluate('({x: window.screenX, y: window.screenY, w: window.outerWidth, h: window.outerHeight})')
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', f'--user-data-dir={ud}', '--remote-debugging-port=9342', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1', SLOP_WALLPAPER='/tmp/wall.jpg', SLOP_WALLPAPER_STYLE='10'), stdout=open('/tmp/slop10.log', 'w'), stderr=subprocess.STDOUT)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9342'); break
            except Exception: pass
        await asyncio.sleep(12)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        st = await ov.evaluate('window.__slopState()'); k = st['k']
        inside = lambda b: b['x'] / k >= win['x'] - 4 and b['y'] / k >= win['y'] - 4 and (b['x'] + b['w']) / k <= win['x'] + win['w'] + 4 and (b['y'] + b['h']) / k <= win['y'] + win['h'] + 4
        bl = [b for b in st['boxes'] if b['blurred']]
        pass
        print(f"'Ignore my desktop wallpaper' {'ON ' if ignore else 'OFF'}: blurred inside the browser window: {sum(1 for b in bl if inside(b))}, blurred on the desktop wallpaper: {sum(1 for b in bl if not inside(b))}")
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
async def main():
    await run(False); await run(True)
    print('log:', [l[25:120] for l in open('/tmp/slop10.log').read().splitlines() if 'wallpaper' in l][:3])
asyncio.run(main())
