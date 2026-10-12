import asyncio, os, subprocess, time, shutil, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
UD = '/tmp/slop-ud21'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', ':79', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    shutil.rmtree(UD, ignore_errors=True)
    el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', f'--user-data-dir={UD}', '--remote-debugging-port=9352', '/home/claude/ai-slop/overlay/app'],
                          env=dict(os.environ, DISPLAY=':79', SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu5'), stdout=open('/tmp/slop21.log', 'w'), stderr=subprocess.STDOUT)
    async with async_playwright() as p:
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9352'); break
            except Exception: pass
        await asyncio.sleep(6)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        press = "document.querySelector('#gear').dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}))"
        await ov.evaluate(press); await asyncio.sleep(0.3)
        print('after one press on the gear, menu open:', await ov.evaluate("!document.querySelector('#menu').hidden"), '| menu top edge:', await ov.evaluate("document.querySelector('#menu').getBoundingClientRect().top"), '| bar bottom edge:', await ov.evaluate("document.querySelector('#bar').getBoundingClientRect().bottom"))
        await ov.evaluate("document.querySelector('#menu input[data-k=\"video\"]').click()"); await asyncio.sleep(0.6)
        print('switch in the menu still saves: video =', json.load(open(f'{UD}/settings.json')).get('video'))
        await ov.evaluate(press); await asyncio.sleep(0.3)
        print('after a second press, menu open:', await ov.evaluate("!document.querySelector('#menu').hidden"))
    el.terminate(); xvfb.terminate()
    print('log:', [l[25:110] for l in open('/tmp/slop21.log').read().splitlines() if 'menu' in l or 'bar pressed' in l or 'overlay error' in l])
asyncio.run(main())
