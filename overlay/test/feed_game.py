import json, time, sys
def emit(o, secs):
    end = time.time() + secs
    while time.time() < end:
        print(json.dumps(o), flush=True); time.sleep(1)
emit({'fg': 'chrome', 'path': 'C:\\Program Files\\Google\\Chrome\\chrome.exe', 'quns': 5, 'ac': []}, 6)                 # browsing
emit({'fg': 'chrome', 'path': 'C:\\Program Files\\Google\\Chrome\\chrome.exe', 'quns': 5, 'ac': ['EasyAntiCheat']}, 6)   # a game with anti-cheat starts (alt-tabbed to chrome)
emit({'fg': 'chrome', 'path': 'C:\\Program Files\\Google\\Chrome\\chrome.exe', 'quns': 5, 'ac': []}, 13)                # game closed
emit({'fg': 'chrome', 'path': 'C:\\Program Files\\Google\\Chrome\\chrome.exe', 'quns': 2, 'ac': []}, 4)                 # full-screen YouTube
emit({'fg': 'Foo', 'path': 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Foo\\Foo.exe', 'quns': 5, 'ac': []}, 5) # a Steam game in front
emit({'fg': 'chrome', 'path': 'C:\\x\\chrome.exe', 'quns': 5, 'ac': []}, 100)
