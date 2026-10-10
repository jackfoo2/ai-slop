import asyncio, os, subprocess, time, shutil
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':88'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8742'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISP); shutil.rmtree('/tmp/slop-ud12', ignore_errors=True)
    open('/tmp/fakecpu', 'w').write('5')
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1080'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1080}); await pg.goto('http://localhost:8742/explorer.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', '--user-data-dir=/tmp/slop-ud12', '--remote-debugging-port=9344', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu'), stdout=open('/tmp/slop12.log', 'w'), stderr=subprocess.STDOUT)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9344'); break
            except Exception: pass
        await asyncio.sleep(12)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        s0 = await ov.evaluate('window.__slopState()'); await asyncio.sleep(10); s1 = await ov.evaluate('window.__slopState()')
        print(f"still screen, 10 s: frames fully processed {s1['processed'] - s0['processed']}, skipped as unchanged {s1['idle'] - s0['idle']} | blurred {sum(1 for b in s1['boxes'] if b['blurred'])}")
        await pg.mouse.wheel(0, 120); await asyncio.sleep(2.5); s2 = await ov.evaluate('window.__slopState()')
        print(f"after a scroll: processed {s2['processed'] - s1['processed']} more frames (work resumes when the screen changes)")
        open('/tmp/fakecpu', 'w').write('50')
        for t in range(8):
            await asyncio.sleep(2.5); print(f"   CPU faked at 50%, {2.5 * (t + 1):4.1f} s: level {await ov.evaluate('window.__slopState().level')}")
        open('/tmp/fakecpu', 'w').write('5')
        for t in range(6):
            await asyncio.sleep(5); print(f"   CPU faked at 5%,  {5 * (t + 1):4.1f} s: level {await ov.evaluate('window.__slopState().level')}")
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
    print('log:', [l[25:110] for l in open('/tmp/slop12.log').read().splitlines() if ' cpu ' in l][:10])
asyncio.run(main())
