import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml']
]);

const server = createServer(async (request, response) => {
    try {
        const pathname = decodeURIComponent(new URL(request.url || '/', `http://${host}`).pathname);
        const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
        const target = path.resolve(root, relative);
        if (target !== path.join(root, 'index.html') && !target.startsWith(`${root}${path.sep}`)) {
            response.writeHead(403).end('Forbidden');
            return;
        }
        const info = await stat(target);
        if (!info.isFile()) throw new Error('Not a file');
        response.writeHead(200, {
            'Content-Type': contentTypes.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        createReadStream(target).pipe(response);
    } catch {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
    }
});

server.listen(port, host, () => {
    console.log(`ElainaChat Open Web: http://${host}:${port}`);
    console.log('This static server does not proxy or receive provider API requests.');
});
