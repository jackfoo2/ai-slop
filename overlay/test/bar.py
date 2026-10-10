import asyncio, os, subprocess, time, shutil, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':97'
async def main():
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    shutil.rmtree('/tmp/slop-ud3', ignore_errors=True)
    el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud3', '--remote-debugging-port=9335', '/home/claude/overlay/app'],
                          env=dict(os.environ, DISPLAY=DISP, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1'), stdout=open('/tmp/slop3.log', 'w'), stderr=subprocess.STDOUT)
    async with async_playwright() as p:
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9335'); break
            except Exception: pass
        await asyncio.sleep(4)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        saved = lambda: json.load(open('/tmp/slop-ud3/settings.json')).get('paused') if os.path.exists('/tmp/slop-ud3/settings.json') else None
        for n in range(3):
            await ov.evaluate("document.querySelector('#onoff').click()"); await asyncio.sleep(1.2)
            st = await ov.evaluate('window.__slopState().paused')
            print(f'click {n + 1}: overlay thinks paused={st}, saved paused={saved()}, button says {await ov.evaluate("document.querySelector(\'#onoff\').textContent")}')
    el.terminate(); xvfb.terminate()
asyncio.run(main())
