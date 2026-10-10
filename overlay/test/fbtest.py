import asyncio, os, subprocess, time, shutil, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
DISP, UD = ':85', '/tmp/slop-ud15'
async def main():
    for pat in ['^/home/claude/overlay/dl/electron-linux/electron', '^Xvfb', '^python3 -m http.server']: subprocess.run(['pkill', '-f', pat])
    time.sleep(1)
    xvfb = subprocess.Popen(['Xvfb', DISP, '-screen', '0', '1920x1080x24', '-nolisten', 'tcp'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8744'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1.5)
    env = dict(os.environ, DISPLAY=DISP); shutil.rmtree(UD, ignore_errors=True)
    open('/tmp/fgfeed.sh', 'w').write("while true; do if [ -f /tmp/fg_discord ]; then echo '{\"fg\":\"Discord\",\"path\":\"\",\"quns\":5,\"ac\":[]}'; else echo '{\"fg\":\"chrome\",\"path\":\"\",\"quns\":5,\"ac\":[]}'; fi; sleep 1; done\n")
    if os.path.exists('/tmp/fg_discord'): os.remove('/tmp/fg_discord')
    async with async_playwright() as p:
        br = await p.chromium.launch(headless=False, env=env, args=['--kiosk', '--window-position=0,0', '--window-size=1920,1080'])
        pg = await br.new_page(viewport={'width': 1920, 'height': 1080}); await pg.goto('http://localhost:8744/labels.html'); await pg.wait_for_timeout(1000)
        el = subprocess.Popen(['/home/claude/overlay/dl/electron-linux/electron', '--no-sandbox', f'--user-data-dir={UD}', '--remote-debugging-port=9346', '/home/claude/ai-slop/overlay/app'],
                              env=dict(env, SLOP_MODEL='/home/claude/overlay/standin-model.onnx', SLOP_HIDDEN='1', SLOP_DEBUG='1', SLOP_FAKE_CPU_FILE='/tmp/fakecpu5', SLOP_GAME_CMD='sh /tmp/fgfeed.sh'), stdout=open('/tmp/slop15.log', 'w'), stderr=subprocess.STDOUT)
        cdp = None
        for _ in range(30):
            await asyncio.sleep(1)
            try: cdp = await p.chromium.connect_over_cdp('http://127.0.0.1:9346'); break
            except Exception: pass
        await asyncio.sleep(10)
        ov = [q for c in cdp.contexts for q in c.pages if 'overlay.html' in q.url][0]
        for _ in range(30):
            ui = await ov.evaluate('window.__slopUI()')
            if sum(1 for c in ui['chips'] if 'Label' in c or 'Watermark' in c) >= 4: break
            await asyncio.sleep(2)
        blurred = lambda: ov.evaluate("window.__slopState().boxes.filter(b => b.blurred).length")
        async def say(chip_i, text):
            await ov.evaluate(f"document.querySelectorAll('.chip')[{chip_i}].querySelector('.rate.more').click()"); await asyncio.sleep(0.4)
            vis = await ov.evaluate("!document.querySelector('#fb').hidden")
            await ov.evaluate(f"(() => {{ const i = document.querySelector('#fbIn'); i.value = {json.dumps(text)}; document.querySelector('#fbSend').click(); }})()"); await asyncio.sleep(1.5)
            return vis, await ov.evaluate("document.querySelector('#toast .msg').textContent")
        print('blurred at start:', await blurred())
        vis, msg = await say(0, 'this is a real photo of my friend'); print(f'box opened: {vis} | "this is a real photo of my friend" -> {msg} | blurred now: {await blurred()}')
        sens0 = json.load(open(f'{UD}/settings.json')).get('sensitivity', 'balanced') if os.path.exists(f'{UD}/settings.json') else 'balanced'
        vis, msg = await say(1, 'too many false alarms'); sens1 = json.load(open(f'{UD}/settings.json'))['sensitivity']
        print(f'"too many false alarms" -> {msg} | sensitivity {sens0} -> {sens1}')
        await ov.evaluate("document.querySelector('#toast .undo').click()"); await asyncio.sleep(1)
        print('Undo ->', await ov.evaluate("document.querySelector('#toast .msg').textContent"), '| sensitivity now', json.load(open(f'{UD}/settings.json'))['sensitivity'])
        open('/tmp/fg_discord', 'w').write('1'); await asyncio.sleep(2.5)
        vis, msg = await say(1, 'stop blurring stuff in discord'); print(f'with Discord in front: "stop blurring stuff in discord" -> {msg} | offIn = {json.load(open(f"{UD}/settings.json")).get("offIn")}')
        await asyncio.sleep(4)
        alive = any('overlay.html' in q.url for c in cdp.contexts for q in c.pages)
        print('overlay window present while Discord is in front:', alive)
        os.remove('/tmp/fg_discord'); await asyncio.sleep(13)
        print('Discord no longer in front, 13 s later -> overlay back:', any('overlay.html' in q.url for c in (await p.chromium.connect_over_cdp('http://127.0.0.1:9346')).contexts for q in c.pages))
        el.terminate(); await br.close()
    srv.terminate(); xvfb.terminate()
    fb = [json.loads(l) for l in open(f'{UD}/ratings/feedback.jsonl')]
    print('saved feedback:', [(f['text'][:30], f['action']['action'], f['how'], f['file'] is not None) for f in fb])
asyncio.run(main())
