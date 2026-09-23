// Run: node __tests__/home/randomUi.test.mjs (uses system Chromium, no live backend).
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { chromium, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = root + '__fixture.jsx';
const server = await createServer({ root, configFile: false, envFile: false,
  cacheDir: '/tmp/catalog-random-ui-vite',
  plugins: [{ name: 'home-ui-fixture', enforce: 'pre',
    configureServer(server) {
      server.middlewares.use('/__home-test.html', async (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(await server.transformIndexHtml('/__home-test.html', '<div id="root"></div><script type="module" src="/__fixture.jsx"></script>'));
      });
    },
    resolveId(id) { if (id === '/__fixture.jsx') return fixture; },
    load(id) {
      if (id.endsWith('/Search/GameGrid.tsx')) return `import React from 'react'; export default function Grid({games,scores}) { return React.createElement('ol', {id:'cards'}, games.map(g => React.createElement('li', {key:g.id,'data-id':g.id,'data-score':scores?.get(g.id)},g.title))); }`;
      if (id === fixture) return `import React from 'react'; import {createRoot} from 'react-dom/client';
        import {BrowserRouter,useNavigate} from 'react-router-dom';
        import HomePage from '/src/components/Home/HomePage.tsx';
        function App(){const navigate=useNavigate();return <><button onClick={()=>navigate('/')}>Home logo</button><button onClick={()=>navigate('?sem=space')}>Semantic mode</button><button onClick={()=>navigate('?format=img')}>Image filter</button><HomePage selectedTags={[]} selectedAuthors={[]} filterMode="all" blockedTags={[]}/></>}
        createRoot(document.getElementById('root')).render(<BrowserRouter><App/></BrowserRouter>);`;
    },
  }, react()], server: { host: '127.0.0.1', port: 5178, strictPort: true },
});
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
try {
  for (const width of [1400, 600]) {
    const page = await browser.newPage({ viewport: {width, height: 900} });
    const games = Array.from({length: 80}, (_, i) => ({id:String(i).padStart(15,'0'),title:`Game ${i}`, authors:[],tags:[], expand:{authors:[],tags:[]}}));
    let release, releaseFeed, releasePins, releaseSemantic, requests=0, fail=false;
    let delayFeed=false, delayPins=false;
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url());
      const fields = url.searchParams.get('fields');
      const filter = url.searchParams.get('filter') || '';
      if (url.pathname === '/api/semantic-search') {
        await new Promise(resolve=>{releaseSemantic=resolve;});
        await route.fulfill({json:{results:games.slice(0,4).map(g=>({id:g.id,score:0.9}))}});return;
      }
      let items=[];
      if (url.pathname.includes('/games/')) {
        if (fields === 'id') items=games.map(({id})=>({id}));
        else if (filter.includes('original_release')) {
          if(delayPins) await new Promise(resolve=>{releasePins=resolve;});
          items=[games[3]];
        }
        else if (filter.includes('id="')) {
          requests++;
          await new Promise(resolve=>{release=resolve;});
          if(fail){ await route.fulfill({status:500,json:{message:'test failure'}});return; }
          items=games.filter(g=>filter.includes(`id="${g.id}"`));
        } else if(fields === 'tags') items=[];
        else {
          if(delayFeed) await new Promise(resolve=>{releaseFeed=resolve;});
          items=games.slice(0,10);
        }
      }
      await route.fulfill({json:{page:1,perPage:500,totalItems:items.length,totalPages:1,items}});
    });
    const errors=[];page.on('pageerror',error=>(errors.push(error.message), console.error(error.message)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__home-test.html`);
    const ids=()=>page.locator('#cards li').evaluateAll(nodes=>nodes.map(n=>n.dataset.id));
    await expect(page.locator('#cards li').first()).toHaveText('Game 3');
    const initial=await ids();
    await page.getByRole('button',{name:'Random picks',exact:true}).click();
    await expect.poll(()=>requests).toBe(1);
    assert.deepEqual(await ids(),initial,'Fresh order must remain unchanged while random cards load');
    release();
    const random=page.getByRole('button',{name:'Roll again',exact:true});
    await expect(random).toBeEnabled();
    await expect(random).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('#cards li')).toHaveCount(20);
    const first=await ids();
    for(let n=2;n<=3;n++){
      const before=await ids();
      await random.click();
      await expect.poll(()=>requests).toBe(n);
      assert.equal(new URL(page.url()).searchParams.get('seed'),'random');
      await expect(random).toHaveAttribute('aria-pressed','true');
      assert.deepEqual(await ids(),before);
      release();await expect(random).toBeEnabled();
      assert.ok((await ids()).every(id=>!first.includes(id)));
    }
    fail=true;
    const beforeFailure=await ids();await random.click();await expect.poll(()=>requests).toBe(4);release();
    await expect(random).toBeEnabled();assert.deepEqual(await ids(),beforeFailure);
    await expect(random).toHaveAttribute('aria-pressed','true');
    fail=false;delayFeed=true;
    await page.getByRole('button',{name:'Most liked',exact:true}).click();
    await expect.poll(()=>typeof releaseFeed).toBe('function');
    await expect.poll(()=>new URL(page.url()).searchParams.get('seed')).toBe(null);
    assert.deepEqual(await ids(),beforeFailure,'Changing sort must retain the displayed result while loading');
    releaseFeed();releaseFeed=undefined;
    await expect(page.locator('#cards li')).toHaveCount(10);
    const sorted=await ids();
    delayPins=true;
    await page.getByRole('button',{name:'Home logo',exact:true}).click();
    await expect.poll(()=>typeof releaseFeed).toBe('function');
    await expect.poll(()=>typeof releasePins).toBe('function');
    releaseFeed();releaseFeed=undefined;
    assert.deepEqual(await ids(),sorted,'Feed response alone must not change layout before pins are ready');
    releasePins();releasePins=undefined;
    await expect(page.locator('#cards li').first()).toHaveText('Game 3');
    const pinned=await ids();
    await page.getByRole('button',{name:'Image filter',exact:true}).click();
    await expect.poll(()=>typeof releaseFeed).toBe('function');
    assert.deepEqual(await ids(),pinned,'Filters must not unpin the old displayed result');
    releaseFeed();releaseFeed=undefined;
    await expect(page.locator('#cards li').first()).toHaveText('Game 0');
    const filtered=await ids();
    await page.getByRole('button',{name:'Semantic mode',exact:true}).click();
    await expect.poll(()=>typeof releaseSemantic).toBe('function');
    assert.deepEqual(await ids(),filtered);
    release=undefined;releaseSemantic();
    await expect.poll(()=>typeof release).toBe('function');
    assert.deepEqual(await ids(),filtered,'Semantic IDs alone must not replace the old grid');
    release();
    await expect(page.locator('#cards li')).toHaveCount(4);
    await expect(page.locator('#cards li').first()).toHaveAttribute('data-score','0.9');
    const semantic=await ids();
    await page.getByRole('button',{name:'Home logo',exact:true}).click();
    await expect.poll(()=>typeof releaseFeed).toBe('function');
    await expect.poll(()=>typeof releasePins).toBe('function');
    assert.deepEqual(await ids(),semantic);
    await expect(page.locator('#cards li').first()).toHaveAttribute('data-score','0.9');
    releasePins();releaseFeed();
    await expect(page.locator('#cards li').first()).toHaveText('Game 3');
    await expect(page.locator('#cards li').first()).not.toHaveAttribute('data-score');
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px: stable Fresh order, repeated rolls, errors, sorts, filters, semantic scores and staged pins`);
    await page.close();
  }
} finally {await browser.close();await server.close();}
