function flattenCubicBounds(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    cb: (x: number, y: number) => void,
) {
    const tolerance = 0.25;
    const stack: number[][] = [];
    stack.push([x0, y0, x1, y1, x2, y2, x3, y3]);

    while (stack.length > 0) {
        const [ax, ay, bx, by, cx, cy, dx, dy] = stack.pop()!;

        const ux = 3 * bx - 2 * ax - dx;
        const uy = 3 * by - 2 * ay - dy;
        const vx = 3 * cx - ax - 2 * dx;
        const vy = 3 * cy - ay - 2 * dy;
        const maxDist = Math.max(ux * ux, vx * vx) + Math.max(uy * uy, vy * vy);
        if (maxDist <= 16 * tolerance * tolerance) {
            cb(dx, dy);
        } else {
            const abx = (ax + bx) / 2,
                aby = (ay + by) / 2;
            const bcx = (bx + cx) / 2,
                bcy = (by + cy) / 2;
            const cdx = (cx + dx) / 2,
                cdy = (cy + dy) / 2;
            const abcx = (abx + bcx) / 2,
                abcy = (aby + bcy) / 2;
            const bcdx = (bcx + cdx) / 2,
                bcdy = (bcy + cdy) / 2;
            const midx = (abcx + bcdx) / 2,
                midy = (abcy + bcdy) / 2;

            stack.push([midx, midy, bcdx, bcdy, cdx, cdy, dx, dy]);
            stack.push([ax, ay, abx, aby, abcx, abcy, midx, midy]);
        }
    }
}

function calculatePathBounds(path: any) {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    let hasPoints = false;

    for (const sp of path.subpaths) {
        const pts = sp.points;
        const n = pts.length;
        if (n === 0) continue;

        hasPoints = true;
        minX = Math.min(minX, pts[0].x);
        minY = Math.min(minY, pts[0].y);
        maxX = Math.max(maxX, pts[0].x);
        maxY = Math.max(maxY, pts[0].y);

        for (let i = 1; i < n; i++) {
            const a = pts[i - 1];
            const b = pts[i];
            flattenCubicBounds(
                a.x,
                a.y,
                a.cp2[0],
                a.cp2[1],
                b.cp1[0],
                b.cp1[1],
                b.x,
                b.y,
                (x, y) => {
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x);
                    maxY = Math.max(maxY, y);
                },
            );
        }
    }

    if (!hasPoints) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
}

const geo = {
    subpaths: [
        {
            closed: false,
            points: [
                { x: 0, y: 0, cp1: [0, 0], cp2: [50, 50] },
                { x: 100, y: 0, cp1: [50, 50], cp2: [100, 0] },
            ],
        },
    ],
};

console.log('Renderer Bounds:', calculatePathBounds(geo));
