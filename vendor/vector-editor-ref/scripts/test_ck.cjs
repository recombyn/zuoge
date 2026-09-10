const CanvasKitInit = require('canvaskit-wasm');

async function run() {
    const ck = await CanvasKitInit();
    const surface = ck.MakeSurface(100, 100);
    const canvas = surface.getCanvas();
    canvas.clear(ck.TRANSPARENT);

    const image = surface.makeImageSnapshot();
    try {
        const pixels = image.readPixels(0, 0, {
            width: 100,
            height: 100,
            colorType: ck.ColorType.RGBA_8888,
            alphaType: ck.AlphaType.Unpremul,
            colorSpace: ck.ColorSpace.SRGB
        });
        console.log("readPixels success:", !!pixels, pixels.length);
    } catch (e) {
        console.error("readPixels error:", e);
    }
}
run();
