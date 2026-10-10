import asyncio, os, subprocess, time, json, sys
os.environ['PLAYWRIGHT_BROWSERS_PATH'] = '/opt/pw-browsers'
from playwright.async_api import async_playwright
from PIL import Image
async def main():
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8738'], cwd='/home/claude/ai-slop/overlay/test/feed', stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1920, 'height': 1080})
        for name in ['cutouts_light', 'cutouts_dark', 'explorer', 'index']:
            await pg.goto(f'http://localhost:8738/{name}.html'); await pg.wait_for_timeout(1200)
            await pg.screenshot(path=f'/tmp/{name}.png')
            rects = await pg.evaluate("[...document.querySelectorAll('.media')].map(e => { const r = e.getBoundingClientRect(); return {x: r.left, y: r.top, w: r.width, h: r.height}; }).filter(r => r.y >= 0 && r.y + r.h <= 1080)")
            json.dump(rects, open(f'/tmp/{name}.json', 'w'))
            Image.open(f'/tmp/{name}.png').convert('RGBA').resize((1280, 720), Image.BILINEAR).save(f'/tmp/{name}_1280.png')
        await b.close()
    srv.terminate()
asyncio.run(main())
