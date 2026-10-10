import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':93'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8735'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISP)
    shutil.rmtree('/tmp/slop-ud7', ignore_errors=True)
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1280,800'])
        pg = await br.new_page(viewport={'width': 1280, 'height': 800}); await pg.goto('http://localhost:8735/grid.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud7', '--remote-debugging-port=9339', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9339'); break
            except Exception: pass
        await asyncio.sleep(8)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        async def report(label):
            st = await ov.evaluate('window.__slopState()')
            vis = await pg.evaluate("[...document.querySelectorAll('.media')].filter(e => { const r = e.getBoundingClientRect(); return r.top > -50 && r.bottom < 850; }).length")
            blurred = sum(1 for b in st['boxes'] if b['blurred'])
            print(f"{label}: {vis} pictures fully or mostly on screen, {len(st['boxes'])} tracked, {blurred} blurred | page moved {st['scrollAcc']} px, remembered {st['departed']}")
        await report('AT REST (grid, 6 on screen)')
        for _ in range(15): await pg.mouse.wheel(0, 40); await asyncio.sleep(1.3)
        await report('AFTER SCROLLING DOWN 600 px')
        for _ in range(15): await pg.mouse.wheel(0, -40); await asyncio.sleep(1.3)
        await asyncio.sleep(0.5)
        await report('BACK AT THE TOP')
        await asyncio.sleep(3); await report('AGAIN 3 S LATER')
        st = await ov.evaluate('window.__slopState()'); print('   boxes:', [{kk: v for kk, v in b.items() if kk in ('y', 'blurred', 'covered', 'cellsOn', 'dynamic', 'p')} for b in st['boxes']])
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
asyncio.run(main())
