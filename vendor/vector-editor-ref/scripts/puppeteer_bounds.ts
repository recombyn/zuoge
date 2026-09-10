import puppeteer from 'puppeteer';

(async () => {
    console.log('Starting puppeteer...');
    const browser = await puppeteer.launch({ headless: 'new' });
    const page = await browser.newPage();

    page.on('console', (msg) => console.log('PAGE LOG:', msg.text()));

    console.log('Navigating to http://localhost:5173...');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0' });

    // Wait for the app to initialize
    await page.waitForFunction(() => (window as any).app?.scene?.engine);
    // Give it an extra second to load from LocalStorage
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Evaluate logic to get bounds
    const data = await page.evaluate(() => {
        const app = (window as any).app;

        const selection = Array.from(app.scene.engine.get_selection());
        let id: unknown;

        const sceneData = JSON.parse(app.scene.engine.get_scene_json());

        if (selection.length > 0) {
            id = selection[0];
        } else {
            // Find a path node
            const nodes = Object.entries(sceneData.nodes);
            const pathNode = nodes.find(([_, n]: [string, any]) => n.node_type === 'Path');
            if (!pathNode) return 'No path found in scene.';
            id = parseInt(pathNode[0], 10);
        }

        const bounds = Array.from(app.scene.getNodeBounds(id));
        const transform = Array.from(app.scene.getTransform(id));
        const geo = app.scene.getNodeGeometry(id);
        const pathBounds = app.scene.calculatePathBounds(geo.Path);

        return {
            id,
            bounds,
            transform,
            geo: JSON.stringify(geo), // stringify to avoid circular/complex proxy issues
            pathBounds,
            node: sceneData.nodes[id],
        };
    });

    console.log('Extracted Data:');
    console.log(data);

    await browser.close();
})();
