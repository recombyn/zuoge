import puppeteer from 'puppeteer';

async function run() {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();

    // Wait for the server to be ready
    console.log('Navigating to localhost...');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });

    console.log('App loaded. Running test...');

    const result = await page.evaluate(() => {
        const app = (window as any).app;
        if (!app) return { error: 'App not found on window' };

        const scene = app.scene;
        const engine = scene.engine;

        // 1. Create a path directly in the engine
        const subpaths = [
            {
                points: [
                    { x: 0, y: 0, cp1: [0, 0], cp2: [50, 50] },
                    { x: 100, y: 0, cp1: [50, 50], cp2: [100, 0] },
                ],
                closed: false,
            },
        ];

        const json = JSON.stringify(subpaths);
        const id = engine.add_path(json);
        engine.set_node_transform(id, JSON.stringify([2, 0, 0, 0, 2, 0, 50, 0, 1]));

        const beforeBounds = engine.get_node_bounds(id);
        const beforeTransform = scene.getTransform(id);
        engine.select_node(id, false);

        // Call flattenSelection
        app.input.flattenSelection();

        const afterBounds = engine.get_node_bounds(id);
        const afterTransform = scene.getTransform(id);
        const afterGeo = scene.getNodeGeometry(id);

        return {
            id,
            beforeBounds,
            beforeTransform: Array.from(beforeTransform),
            afterBounds,
            afterTransform: Array.from(afterTransform),
            afterGeo,
        };
    });

    console.log(JSON.stringify(result, null, 2));

    await browser.close();
}

run().catch(console.error);
