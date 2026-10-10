import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':95'
async def overlay_open(p):
    try:
        cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9337')
        n = sum(1 for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url); await cdp.close(); return n > 0
    except Exception as e: return f'?'
async def main():
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    shutil.rmtree('/tmp/slop-ud5', ignore_errors=True)
    env = dict(os.environ, DISPLAY=DISP, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1', SLOP_GAME_CMD='python3 -u /home/claude/overlay/test/feed_game.py')
    el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud5', '--remote-debugging-port=9337', '/home/claude/overlay/app'], env=env, stdout=open('/tmp/slop5.log', 'w'), stderr=subprocess.STDOUT)
    t0 = time.time()
    async with async_playwright() as p:
        await asyncio.sleep(4)
        for t in [5, 9, 13, 20, 27, 31, 33, 36]:
            while time.time() - t0 < t: await asyncio.sleep(0.2)
            print(f'{t:3d}s  overlay window present: {await overlay_open(p)}')
    el.terminate(); xvfb.terminate()
    print('--- log:'); print('\n'.join(l[25:] for l in open('/tmp/slop5.log').read().splitlines() if any(x in l for x in ['game', 'overlay removed', 'coming back'])))
asyncio.run(main())
