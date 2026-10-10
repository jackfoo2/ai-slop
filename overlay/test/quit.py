import asyncio, os, subprocess, time, shutil, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':96'
EL = ['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud4']
running = lambda: int(subprocess.run(['pgrep', '-fc', '^/home/claude/overlay/dl/electron-linux/electron'], capture_output=True, text=True).stdout.strip() or 0)
async def main():
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    shutil.rmtree('/tmp/slop-ud4', ignore_errors=True)
    env = dict(os.environ, DISPLAY=DISP, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1')
    el = subprocess.Popen(EL + ['--remote-debugging-port=9336', '/home/claude/overlay/app'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    async with async_playwright() as p:
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9336'); break
            except Exception: pass
        await asyncio.sleep(3)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        print('program processes running:', running())
        await ov.evaluate("document.querySelector('#onoff').click()"); await asyncio.sleep(1)
        print('switched off; saved paused =', json.load(open('/tmp/slop-ud4/settings.json'))['paused'])
        second = subprocess.Popen(EL + ['/home/claude/overlay/app'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        await asyncio.sleep(3)
        print('opened again while running: second copy exited =', second.poll() is not None, '| saved paused =', json.load(open('/tmp/slop-ud4/settings.json'))['paused'], '| button says', await ov.evaluate("document.querySelector('#onoff').textContent"))
        try: await ov.evaluate("document.querySelector('#close').click()")
        except Exception: pass
    await asyncio.sleep(2)
    print('after clicking X: program processes still running =', running())
    xvfb.terminate()
asyncio.run(main())
