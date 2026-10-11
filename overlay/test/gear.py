import asyncio, os, subprocess, time, shutil, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
UD = '/tmp/slop-ud17'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', ':83', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    shutil.rmtree(UD, ignore_errors=True); os.makedirs(UD); json.dump({'offIn': ['Discord']}, open(f'{UD}/settings.json', 'w'))
    el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', f'--user-data-dir={UD}', '--remote-debugging-port=9348', '/home/claude/ai-slop/overlay/app'],
                          env=dict(os.environ, DISPLAY=':83', SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu5'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    async with async_playwright() as p:
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9348'); break
            except Exception: pass
        await asyncio.sleep(6)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        print('corner:', await ov.evaluate("""(() => { const b = document.getElementById('bar').getBoundingClientRect(); const top = document.elementFromPoint(b.left + 20, b.top + 12);
          return {barText: document.getElementById('bar').innerText.replace(/\\n/g, ' '), onTop: top ? (top.id || top.className || top.tagName) : null, feedbackBoxShowing: getComputedStyle(document.getElementById('fb')).display !== 'none', messageShowing: getComputedStyle(document.getElementById('toast')).display !== 'none'}; })()"""))
        await ov.evaluate("document.querySelector('#gear').click()"); await asyncio.sleep(0.4)
        print('menu open:', await ov.evaluate("!document.querySelector('#menu').hidden"), '| sections:', await ov.evaluate("[...document.querySelectorAll('#menu h3')].map(h => h.textContent).join(', ')"))
        rd = lambda: json.load(open(f'{UD}/settings.json'))
        await ov.evaluate("document.querySelector('#menu input[data-k=\"showScores\"]').click()"); await asyncio.sleep(0.6)
        click = lambda k, label: ov.evaluate(f"[...document.querySelectorAll('#menu button[data-k={k}]')].find(b => b.textContent === '{label}').click()")
        await click('sensitivity', 'Strict'); await asyncio.sleep(0.6)
        await click('cpuLimit', 'None'); await asyncio.sleep(0.6)
        s = rd(); print('after clicks: showScores', s.get('showScores'), '| sensitivity', s.get('sensitivity'), '| cpuLimit', s.get('cpuLimit'))
        print('highlighted choices:', await ov.evaluate("[...document.querySelectorAll('#menu .seg button.on')].map(b => b.textContent).join(', ')"))
        print('apps listed:', await ov.evaluate("[...document.querySelectorAll('#menu .app span')].map(s => s.textContent)"))
        await ov.evaluate("document.querySelector('#menu button[data-remove=\"Discord\"]').click()"); await asyncio.sleep(0.6)
        print('after "Turn back on": offIn', rd().get('offIn'), '| listed:', await ov.evaluate("[...document.querySelectorAll('#menu .app span')].map(s => s.textContent)"))
        await ov.evaluate("document.querySelector('#gear').click()"); await asyncio.sleep(0.3)
        print('menu closed:', await ov.evaluate("document.querySelector('#menu').hidden"))
    el.terminate(); xvfb.terminate()
asyncio.run(main())
