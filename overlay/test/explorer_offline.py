import asyncio, os, subprocess, time, json
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
async def main():
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8736'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1920, 'height': 1080})
        await pg.goto('http://localhost:8736/explorer.html'); await pg.wait_for_timeout(1200)
        await pg.screenshot(path='test/ex1920.png')
        rects = await pg.evaluate("[...document.querySelectorAll('.media')].map(e => { const r = e.getBoundingClientRect(); return {x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)}; }).filter(r => r.y + r.h <= 1080)")
        json.dump(rects, open('test/ex1920.json', 'w')); await b.close()
    srv.terminate()
asyncio.run(main())
