import asyncio, os, subprocess, time, shutil, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP = ':86'
UD = '/tmp/slop-ud14'
async def start_app(p, env):
    el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', f'--user-data-dir={UD}', '--remote-debugging-port=9345', '/home/claude/ai-slop/overlay/app'],
                          env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu5'), stdout=open('/tmp/slop14.log', 'a'), stderr=subprocess.STDOUT)
    cdp = None
    for _ in range(30):
        await asyncio.sleep(1)
        try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9345'); break
        except Exception: pass
    await asyncio.sleep(14)
    return el, [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8743'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISP); shutil.rmtree(UD, ignore_errors=True); os.makedirs(UD); json.dump({'showScores': True}, open(f'{UD}/settings.json', 'w'))
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1080'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1080}); await pg.goto('http://localhost:8743/labels.html'); await pg.wait_for_timeout(1000)
        el, ov = await start_app(p, env)
        # wait until the four text hits are in
        for _ in range(30):
            ui = await ov.evaluate('window.__slopUI()')
            if sum(1 for c in ui['chips'] if 'Label' in c or 'Watermark' in c) >= 4: break
            await asyncio.sleep(2)
        st = lambda: ov.evaluate("window.__slopState().boxes.map(b => ({x: Math.round(b.x), y: Math.round(b.y), blurred: b.blurred}))")
        before = await st(); print('before rating:', [(b['x'], b['y'], 'blur' if b['blurred'] else 'clear') for b in before])
        chips = await ov.evaluate("[...document.querySelectorAll('.chip')].map((c, i) => ({i, text: c.querySelector('.lbl').textContent, score: c.classList.contains('score')}))")
        blur_chips = [c for c in chips if not c['score']]; score_chips = [c for c in chips if c['score']]
        await ov.evaluate(f"document.querySelectorAll('.chip')[{blur_chips[0]['i']}].querySelector('.rate.down').click()")
        await ov.evaluate(f"document.querySelectorAll('.chip')[{blur_chips[1]['i']}].querySelector('.rate.up').click()")
        await ov.evaluate(f"document.querySelectorAll('.chip')[{score_chips[0]['i']}].querySelector('.rate.down').click()")
        await asyncio.sleep(2.5)
        for r in await ov.evaluate('window.__ratedDebug()'): print('   at rating:', r)
        after = await st(); print('after  rating:', [(b['x'], b['y'], 'blur' if b['blurred'] else 'clear') for b in after])
        print('rated: "−" on', blur_chips[0]['text'], '| "+" on', blur_chips[1]['text'], '| "−" on grey', score_chips[0]['text'])
        el.terminate(); await asyncio.sleep(1.5)
        lines = open(f'{UD}/ratings/ratings.jsonl').read().splitlines()
        print('saved ratings:', [(json.loads(l)['verdict'], 'right' if json.loads(l)['right'] else 'wrong', json.loads(l)['file'] is not None) for l in lines], '| picture files:', len([f for f in os.listdir(f'{UD}/ratings') if f.endswith('.jpg')]))
        el, ov = await start_app(p, env)
        for r in await ov.evaluate('window.__ratedDebug()'): print('   ', r)
        again = await st(); print('after restart:', [(b['x'], b['y'], 'blur' if b['blurred'] else 'clear') for b in again])
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
    print('log:', [l[25:120] for l in open('/tmp/slop14.log').read().splitlines() if 'rated' in l])
asyncio.run(main())
