import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', ':80', '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8747'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=':80'); shutil.rmtree('/tmp/slop-ud20', ignore_errors=True)
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1080'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1080}); await pg.goto('http://localhost:8747/labels.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud20', '--remote-debugging-port=9351', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu5'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9351'); break
            except Exception: pass
        await asyncio.sleep(10)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        for _ in range(30):
            if await ov.evaluate("document.querySelectorAll('.chip:not(.score)').length") >= 3: break
            await asyncio.sleep(2)
        catching = lambda: ov.evaluate('window.__slopUI().catching')
        # mouse onto the first tag's − button
        await ov.evaluate("""(() => { const b = document.querySelector('.chip:not(.score) .rate.down'), r = b.getBoundingClientRect();
          document.dispatchEvent(new MouseEvent('mousemove', {clientX: r.left + 5, clientY: r.top + 5, bubbles: true}));
          b.dispatchEvent(new MouseEvent('mouseenter')); })()""")
        print('mouse on the − button, overlay catching clicks:', await catching())
        await ov.evaluate("document.querySelector('.chip:not(.score) .rate.down').click()"); await asyncio.sleep(1.5)
        print('after − (the tag disappears under the mouse), still catching clicks:', await catching(), '| tag still there:', await ov.evaluate("document.querySelectorAll('.chip:not(.score)').length"))
        # feedback box: open, then focus moves to another window
        await ov.evaluate("document.querySelector('.chip:not(.score) .rate.more').click()"); await asyncio.sleep(0.5)
        print('feedback box open:', await ov.evaluate("!document.querySelector('#fb').hidden"), '| catching clicks while the mouse is elsewhere:', await catching())
        await ov.evaluate("window.dispatchEvent(new Event('blur')); document.querySelector('#fbIn').blur()"); await asyncio.sleep(0.6)
        print('after clicking another window: box open:', await ov.evaluate("!document.querySelector('#fb').hidden"), '| catching clicks:', await catching())
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
asyncio.run(main())
