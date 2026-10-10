import asyncio, os, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
import subprocess, time
async def main():
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8731'], cwd='/home/claude/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
        pg = await b.new_page(viewport={'width': 1280, 'height': 800})
        await pg.goto('http://localhost:8731/index.html'); await pg.wait_for_timeout(1500)
        steps = [30] * 60 + [160, 170, 180] + [30] * 8   # smooth scroll, then a fast flick, then smooth again
        y = 0; meta = []
        for i, st in enumerate([0] + steps):
            y += st
            await pg.evaluate(f'window.scrollTo(0, {y})'); await pg.wait_for_timeout(60)
            rects = await pg.evaluate('''() => [...document.querySelectorAll('.media')].map((e, i) => { const r = e.getBoundingClientRect(); return {i, src: (e.getAttribute('src') || ''), x: r.left, y: r.top, w: r.width, h: r.height}; })''')
            await pg.screenshot(path=f'frames/f{i:03d}.png')
            meta.append({'i': i, 'scroll': y, 'rects': rects})
        json.dump(meta, open('frames/meta.json', 'w'))
        await b.close()
    srv.terminate()
    print('captured', len(meta), 'frames')
asyncio.run(main())
